// dao 脚手架检查 hook — SessionStart · 两种模式
//
// A) windsurf-dao 元仓库：全面同步漂移检测（双向）
//    - hook 文件 vs settings.json 注册
//    - settings.json 快照 vs 本地部署（双向：谁领先提醒谁）
//    - windsurf-dao 未提交改动（本地领先 → 提醒上行）
//    - windsurf-dao 落后 origin（远程领先 → 提醒下行）
//
// B) 普通项目：检查 dao-project-scaffold 标准
//    - CLAUDE.md 存在且 <80 行
//    - .claude/rules/ 存在
//    - 无冗余入口（AGENT_GUIDE.md 等）
//    - docs/ 结构扁平
//    - 活跃 loop（docs/specs/*/STATUS.json mode 非 done/abandoned）
//    - 活跃 plan（docs/plans/*.md 含「待实施/进行中」状态标记）
//
// 发现问题 → 注入 additionalContext。全通过 → 静默退出。
//
// 真相源：windsurf-dao/ccswitch/hooks/dao-scaffold-check.js

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

let raw = "";
try { raw = fs.readFileSync(0, "utf8"); } catch (_) {}

let input = {};
try { input = JSON.parse(raw); } catch (_) {}

const cwd = String(input.cwd || process.cwd());
const homeDir = process.env.HOME || process.env.USERPROFILE || "";

function inject(context) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context }
  }));
  process.exit(0);
}
function done() { process.exit(0); }

// ══════════════════════════════════════════════════════════════
// 模式 B: windsurf-dao 元仓库 — 全面同步漂移检测
// ══════════════════════════════════════════════════════════════

function checkDaoSync() {
  const daoRoot = cwd;
  const drifts = [];

  // 1. Hook 文件 vs settings.json 注册
  try {
    const hooksDir = path.join(daoRoot, "ccswitch", "hooks");
    const settingsPath = path.join(homeDir, ".claude", "settings.json");
    if (fs.existsSync(hooksDir) && fs.existsSync(settingsPath)) {
      const settingsRaw = fs.readFileSync(settingsPath, "utf8");
      const hookFiles = fs.readdirSync(hooksDir)
        .filter(f => f.endsWith(".js"))
        .map(f => f.replace(/\.js$/, ""));
      const unregistered = hookFiles.filter(name => !settingsRaw.includes(name));
      if (unregistered.length > 0) {
        drifts.push("⬇ Hook 未注册：" + unregistered.map(n => n + ".js").join(", ") + " → 需注册到 settings.json");
      }
    }
  } catch (_) {}

  // 2. settings.json / mcp_servers.json 快照比较已移除
  // 原因：config-sync/common/settings.json 是 cc-switch DB 导出格式（含 source/rows 结构
  // + ${HOME}/${PROJECT_ROOT} 占位符），与 ~/.claude/settings.json 结构完全不同，
  // simpleHash 比较永远不同 → 假阳性。git 状态检查已覆盖漂移检测。

  // 3. windsurf-dao 未提交改动
  try {
    const status = execFileSync("git", ["-C", daoRoot, "status", "--porcelain"], {
      encoding: "utf8", timeout: 5000
    }).trim();
    if (status) {
      const changedCount = status.split(/\r?\n/).length;
      drifts.push("⬆ windsurf-dao 有 " + changedCount + " 个未提交改动 → 考虑提交并上行同步");
    }
  } catch (_) {}

  // 5. windsurf-dao 落后 origin（用 last fetch 数据，不联网）
  try {
    const behind = execFileSync("git", ["-C", daoRoot, "rev-list", "--count", "HEAD..origin/master"], {
      encoding: "utf8", timeout: 5000
    }).trim();
    if (parseInt(behind, 10) > 0) {
      drifts.push("⬇ windsurf-dao 落后 origin " + behind + " 个提交 → 运行 dao.bat 下行同步");
    }
    const ahead = execFileSync("git", ["-C", daoRoot, "rev-list", "--count", "origin/master..HEAD"], {
      encoding: "utf8", timeout: 5000
    }).trim();
    if (parseInt(ahead, 10) > 0) {
      drifts.push("⬆ windsurf-dao 领先 origin " + ahead + " 个提交 → 考虑 git push 或 dao.bat --direction=up");
    }
  } catch (_) {}

  if (drifts.length === 0) return;

  inject(
    "【dao 同步漂移检测】windsurf-dao 存在以下同步差异：\n" +
    drifts.join("\n") +
    "\n⬇=远程/快照领先本地（需下行） ⬆=本地领先远程/快照（需上行）。" +
    "请在回答末尾简洁提醒用户。"
  );
}

// windsurf-dao 元仓库：走同步漂移检测
if (path.basename(cwd) === "windsurf-dao") {
  checkDaoSync();
  done();
}

// ══════════════════════════════════════════════════════════════
// 模式 A: 普通项目 — dao-project-scaffold 标准检查
// ══════════════════════════════════════════════════════════════

// 跳过非 git 项目
try {
  if (!fs.existsSync(path.join(cwd, ".git"))) done();
} catch (_) { done(); }

const issues = [];

// 同时检查 windsurf-dao 的同步状态（从任意项目都能检测）
checkDaoDrift();

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

// 8. 桌面端调试基建检测（Tauri / Electron）
try {
  var tauriPaths = ["src-tauri", path.join("apps", "desktop", "src-tauri")];
  var hasTauri = tauriPaths.some(function(d) {
    try { return fs.existsSync(path.join(cwd, d)); } catch (_) { return false; }
  });
  var hasElectron = false;
  try {
    var pkgE = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
    var allDeps = Object.assign({}, pkgE.dependencies, pkgE.devDependencies);
    hasElectron = !!allDeps.electron;
  } catch (_) {}

  if (hasTauri || hasElectron) {
    var framework = hasTauri ? "Tauri" : "Electron";
    if (!fs.existsSync(path.join(cwd, ".claude", "rules", "desktop-debugging.md"))) {
      issues.push(framework + " 桌面端项目缺少 .claude/rules/desktop-debugging.md（MCP 工具选择规则）→ 运行 /dao-project-scaffold");
    }
    try {
      var pkgS = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
      if (!pkgS.scripts || !pkgS.scripts["dev:debug"]) {
        issues.push(framework + " 项目缺少 dev:debug 脚本（WebView2 远程调试端口）→ 参考 stacks/desktop-tauri.md");
      }
    } catch (_) {}
  }
} catch (_) {}

// ── 活跃工作检测（loop + plan） ──

const activeWork = [];

// 6. 活跃 loop：docs/specs/*/STATUS.json mode 非 done/abandoned
try {
  const specsDir = path.join(cwd, "docs", "specs");
  if (fs.existsSync(specsDir) && fs.statSync(specsDir).isDirectory()) {
    for (const topic of fs.readdirSync(specsDir)) {
      if (topic.startsWith("_")) continue;
      const statusFile = path.join(specsDir, topic, "STATUS.json");
      try {
        if (!fs.existsSync(statusFile)) continue;
        const st = JSON.parse(fs.readFileSync(statusFile, "utf8"));
        if (st.mode && st.mode !== "done" && st.mode !== "abandoned") {
          const summary = st.summary || topic;
          const thread = st.thread ? "（" + st.thread + "线）" : "";
          activeWork.push("Loop [" + topic + "] " + summary + " — mode: " + st.mode + thread);
        }
      } catch (_) {}
    }
  }
} catch (_) {}

// 7. 活跃 plan：docs/plans/*.md 含待实施/进行中状态标记（跳过 _legacy/）
try {
  const plansDir = path.join(cwd, "docs", "plans");
  if (fs.existsSync(plansDir) && fs.statSync(plansDir).isDirectory()) {
    const activePatterns = /\*{0,2}状态\*{0,2}\s*[：:]\s*.*(待实施|进行中|draft|active|wip|in.?progress)/i;
    for (const f of fs.readdirSync(plansDir)) {
      if (!f.endsWith(".md")) continue;
      try {
        const head = fs.readFileSync(path.join(plansDir, f), "utf8").slice(0, 1000);
        const match = head.match(activePatterns);
        if (match) {
          const titleMatch = head.match(/^#\s+(.+)/m);
          const title = titleMatch ? titleMatch[1].trim() : f;
          activeWork.push("Plan [" + f + "] " + title + " — " + match[0].trim());
        }
      } catch (_) {}
    }
  }
} catch (_) {}

// ── 汇总输出 ──

if (issues.length === 0 && activeWork.length === 0) done();

const parts = [];
if (issues.length > 0) {
  parts.push(
    "【dao 脚手架检查】本项目存在以下结构问题，请在回答用户问题后追加提醒：\n" +
    issues.map((s, i) => (i + 1) + ". " + s).join("\n") +
    "\n详细模板参考 dao-project-scaffold skill。提醒语气简洁友好，不阻塞用户当前任务。"
  );
}
if (activeWork.length > 0) {
  parts.push(
    "【活跃工作提醒】本项目有未完成的 loop/plan，请在回答用户问题后主动提醒：\n" +
    activeWork.map((s, i) => (i + 1) + ". " + s).join("\n") +
    "\n提醒用户当前进度和可能的下一步，语气简洁，不阻塞当前任务。"
  );
}
inject(parts.join("\n"));

// ── 从任意项目检测 windsurf-dao 同步漂移 ──
function checkDaoDrift() {
  try {
    // 通过 hook 自身路径定位 windsurf-dao
    const daoRoot = path.resolve(__dirname, "..", "..");
    if (!fs.existsSync(path.join(daoRoot, "ccswitch"))) return;

    const driftItems = [];

    // settings.json 快照 vs 部署比较已移除（快照是 cc-switch DB 格式，结构不同导致假阳性）

    // windsurf-dao 未提交
    try {
      const status = execFileSync("git", ["-C", daoRoot, "status", "--porcelain"], {
        encoding: "utf8", timeout: 5000
      }).trim();
      if (status) {
        driftItems.push("⬆ windsurf-dao 有未提交改动");
      }
    } catch (_) {}

    // windsurf-dao 落后 origin
    try {
      const behind = execFileSync("git", ["-C", daoRoot, "rev-list", "--count", "HEAD..origin/master"], {
        encoding: "utf8", timeout: 5000
      }).trim();
      if (parseInt(behind, 10) > 0) {
        driftItems.push("⬇ windsurf-dao 落后 origin " + behind + " 个提交");
      }
    } catch (_) {}

    if (driftItems.length > 0) {
      // 不单独 inject（会终止），而是追加到 issues 里一起报
      issues.push("windsurf-dao 同步漂移：" + driftItems.join("；"));
    }
  } catch (_) {}
}
