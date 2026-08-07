// settings-drift 两态自证 · 单元级（造 fixture 对 → 断言 findings 方向 / 零误报 / 出错不静默）
//
// 跑法：node tests/settings-drift.tests.js   （全绿 exit 0，任一红 exit 1）
//
// 验的是哪一层：**比对逻辑与错误可见性**。它证明「造一次漂移必被检出且方向正确 /
// 一致时零误报 / 出错必留痕不静默」，**不证明**接线真的被宿主调用过
// ——后者只能由非 synthetic 心跳证明（`node ccswitch/lib/settings-drift.js --selfcheck` 第 ② 项）。
//
// 全部用例把状态目录改写到 _tmp/settings-drift-tests/，且带 DAO_SETTINGS_DRIFT_SELFTEST=1，
// 心跳标 synthetic —— 自测绝不许污染 --selfcheck 的接线判定（防自我染绿）。

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const HOME = (process.env.USERPROFILE || process.env.HOME || os.homedir()).replace(/\\/g, "/");
const TMP = path.join(REPO, "_tmp", "settings-drift-tests");
const STATE = path.join(TMP, "state");
const SCAFFOLD_HOOK = path.join(REPO, "ccswitch", "hooks", "dao-scaffold-check.js");

process.env.DAO_SETTINGS_DRIFT_STATE_DIR = STATE;
process.env.DAO_SETTINGS_DRIFT_SELFTEST = "1";
fs.mkdirSync(STATE, { recursive: true });

const lib = require("../ccswitch/lib/settings-drift.js");

// 占位符字面量：拼接写，避免被模板串当插值吃掉
const PH_PROJECT = "$" + "{PROJECT_ROOT}";
const PH_HOME = "$" + "{HOME}";
const SECRET = "__CONFIG_SYNC_SECRET__";

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}

// ── fixture ────────────────────────────────────────────────────────────────
// 快照形态：路径占位符化 + 脱敏；不含第三方（Coffee CLI 之流）写进 live 的东西。
function snapClaude() {
  return {
    env: {
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5",
      ANTHROPIC_AUTH_TOKEN: SECRET,
    },
    includeCoAuthoredBy: false,
    model: "claude-fable-5[1m]",
    theme: "custom:dao-dark",
    permissions: {
      allow: ["Read", "Grep", "Bash(git:*)"],
      deny: ["Bash(grep:*)", "PowerShell(Select-String:*)"],
      defaultMode: "default",
      additionalDirectories: [PH_HOME + "\\.claude"],
    },
    statusLine: { type: "command", command: "node " + PH_PROJECT + "/ccswitch/statusline.js", padding: 0 },
    hooks: {
      SessionStart: [
        { matcher: "startup", hooks: [{ type: "command", command: 'node "' + PH_PROJECT + '/ccswitch/hooks/dao-scaffold-check.js"', timeout: 10 }] },
        { matcher: "startup|clear|resume", hooks: [{ type: "command", command: 'node "' + PH_PROJECT + '/ccswitch/hooks/dao-remove-session.js"', timeout: 5 }] },
      ],
      PostToolUse: [
        { matcher: "Edit|Write|MultiEdit", hooks: [{ type: "command", command: 'node "' + PH_PROJECT + '/ccswitch/hooks/dao-glob-gate.js"', timeout: 10 }] },
      ],
      Stop: [{ hooks: [{ type: "command", command: 'node "' + PH_HOME + '\\.claude\\hooks\\dao-timecode.js" claude', timeout: 5 }] }],
    },
  };
}

// live 形态：真实绝对路径 + 真密钥 + 宿主运行态键 + 第三方注入的 hook。语义上与快照「一致」。
function liveEquivalent() {
  const P = REPO.replace(/\\/g, "/");
  const COFFEE = '"C:/Users/Administrator/AppData/Local/Coffee CLI/coffee-cli.exe" __hook';
  return {
    env: {
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5",
      ANTHROPIC_AUTH_TOKEN: "sk-real-token-value-not-in-snapshot",
    },
    includeCoAuthoredBy: false,
    model: "opus[1m]",                 // 运行态：/model 切过
    theme: "custom:dao-dark",
    showThinkingSummaries: true,       // 运行态：UI 勾过，快照里没有
    permissions: {
      allow: ["Read", "Grep", "Bash(git:*)"],
      deny: ["Bash(grep:*)", "PowerShell(Select-String:*)"],
      defaultMode: "default",
      additionalDirectories: [HOME + "\\.claude"],
    },
    statusLine: { type: "command", command: "node " + P + "/ccswitch/statusline.js", padding: 0 },
    hooks: {
      Notification: [{ hooks: [{ type: "command", command: COFFEE }] }],
      SessionStart: [
        { matcher: "startup", hooks: [{ type: "command", command: 'node "' + P + '/ccswitch/hooks/dao-scaffold-check.js"', timeout: 10 }] },
        { matcher: "startup|clear|resume", hooks: [{ type: "command", command: 'node "' + P + '/ccswitch/hooks/dao-remove-session.js"', timeout: 5 }] },
      ],
      PostToolUse: [
        { matcher: "Edit|Write|MultiEdit", hooks: [{ type: "command", command: 'node "' + P + '/ccswitch/hooks/dao-glob-gate.js"', timeout: 10 }] },
        { matcher: "*", hooks: [{ type: "command", command: COFFEE }] },
      ],
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: COFFEE }] }],
      Stop: [
        { hooks: [{ type: "command", command: 'node "' + HOME + '\\.claude\\hooks\\dao-timecode.js" claude', timeout: 5 }] },
        { hooks: [{ type: "command", command: COFFEE }] },
      ],
    },
  };
}

let seq = 0;
// 落盘一对 fixture 并跑 detect；返回 detect 结果 + 同参数的 hookLines
function runPair(live, snapObj, opts) {
  seq++;
  const livePath = path.join(TMP, `live-${seq}.json`);
  const snapPath = path.join(TMP, `snap-${seq}.json`);
  if (live !== null) fs.writeFileSync(livePath, JSON.stringify(live, null, 2), "utf8");
  if (snapObj !== null) {
    const doc = typeof snapObj === "string" ? snapObj : JSON.stringify({
      source: "cc-switch.settings",
      note: "test fixture",
      rows: [
        { key: "common_config_claude", value: JSON.stringify(snapObj) },
        { key: "common_config_codex", value: "[non-json toml]" },
      ],
    }, null, 2);
    fs.writeFileSync(snapPath, doc, "utf8");
  }
  const o = Object.assign({ real: false, skipRuleEcho: true, livePath, snapshotPath: snapPath }, opts || {});
  return { r: lib.detect(o), lines: lib.hookLines(o) };
}

const hardIds = (r) => r.hard.map((f) => f.kind + ":" + f.id);
const hasHard = (r, kind, id) => r.hard.some((f) => f.kind === kind && f.id === id);

// D1（issue #171）：detect() 返回的 roots 是**结构前提**，不是可选字段。此前每处都直读
// `r.roots.live`，于是 detect 一旦不再返回 roots，测试端以 TypeError **终止整个进程**
// —— 实测后 40 条用例一条都不跑，而「红得对」与「跑到一半炸了」在退出码上都是 1。
// 故所有读 roots 的地方改走这个取值器：结构缺失时返回 null（由专门的断言判红），不崩。
// ⚠ 它只治**形态**（红 vs 崩），不治那件事本身该不该红 —— 该红的仍由下面的断言判。
function rootsSideOf(r, side) {
  const roots = r && r.roots;
  return roots && Array.isArray(roots[side]) ? roots[side] : null;
}

// 单 hook 的最小 settings 对象：给 rootsOf 做单元级夹具用（不落盘、不过 detect）。
const oneHookObj = (cmd) => ({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: cmd }] }] } });

// ══════════════════════════════════════════════════════════════════════════
console.log("\n=== 负态：语义一致时零硬报（占位符 / 脱敏 / 第三方 hook / 运行态键都不许误伤）===");
{
  const { r, lines } = runPair(liveEquivalent(), snapClaude());
  check("一致 → 零硬发现", r.hard.length === 0, "实得 " + JSON.stringify(hardIds(r)));
  check("一致 → hookLines 全空（健康时静默）", lines.length === 0, JSON.stringify(lines));
  check("一致 → 无内部错误", r.errors.length === 0, JSON.stringify(r.errors));
  check("一致 → 契约字面量守卫未报警", r.degraded.length === 0, JSON.stringify(r.degraded));
  check("一致 → 运行态差异仍被软区记录（不是没看见，是有意不提醒）",
    r.findings.some((f) => f.tier === "soft" && f.id === "model") &&
    r.findings.some((f) => f.tier === "soft" && f.id === "showThinkingSummaries"),
    JSON.stringify(r.findings.filter((f) => f.tier === "soft").map((f) => f.id)));
  check("一致 → 被脱敏的 env 密钥键不产生任何发现",
    !r.findings.some((f) => /ANTHROPIC_AUTH_TOKEN/.test(f.detail || "")),
    JSON.stringify(r.findings.map((f) => f.detail)));
}
{
  // 守 daoScriptOf 的**归属判据**：别的工具也会往 live 注册 node 脚本，它不归 cc-switch 托管，
  // 快照里本就不该有；误报就会永久唠叨，检查器随即被人删掉（上一版检查器正是被假阳性搞掉的）。
  // 这条是 mutation 补出来的：原先第三方例子只用 .exe，由扩展名兜住，归属判据实际零覆盖。
  const live = liveEquivalent();
  live.hooks.PreToolUse.push({ matcher: "Bash", hooks: [{ type: "command", command: 'node "C:/Program Files/OtherTool/their-hook.js"', timeout: 5 }] });
  live.hooks.SessionStart.push({ matcher: "startup", hooks: [{ type: "command", command: 'node "C:/tools/vendor/session-init.js"', timeout: 5 }] });
  const { r, lines } = runPair(live, snapClaude());
  check("第三方非 dao 的 .js hook → 零硬报（归属判据生效）", r.hard.length === 0, JSON.stringify(hardIds(r)));
  check("第三方非 dao 的 .js hook → 不产生提醒噪音", lines.length === 0, JSON.stringify(lines));
}

console.log("\n=== 正态 ⬆：live 多出 dao hook（今日那笔债的形状）===");
{
  const live = liveEquivalent();
  live.hooks.PostToolUse[0].hooks.push({
    type: "command", command: 'node "' + REPO.replace(/\\/g, "/") + '/ccswitch/hooks/dao-rule-echo.js"', timeout: 10,
  });
  const { r, lines } = runPair(live, snapClaude());
  check("live 独有 dao hook → LIVE_ONLY", hasHard(r, "LIVE_ONLY", "hook:dao-rule-echo.js"), JSON.stringify(hardIds(r)));
  check("live 独有 dao hook → 不误产 SNAP_ONLY", !r.hard.some((f) => f.kind === "SNAP_ONLY"), JSON.stringify(hardIds(r)));
  check("提醒含 ⬆ 方向标", lines.some((l) => l.startsWith("⬆")), JSON.stringify(lines));
  check("提醒点明「会被静默抹掉」的后果", lines.some((l) => /静默抹掉/.test(l)), JSON.stringify(lines));
  check("提醒给出 ⬆ 专属修法（export 落快照）", lines.some((l) => /export/.test(l)), JSON.stringify(lines));
}

console.log("\n=== 正态 ⬇：快照有、live 没有（restore/下发没跑）===");
{
  const snap = snapClaude();
  snap.hooks.UserPromptSubmit = [{ hooks: [{ type: "command", command: 'node "' + PH_PROJECT + '/ccswitch/hooks/dao-rhythm.js"', timeout: 10 }] }];
  const { r, lines } = runPair(liveEquivalent(), snap);
  check("快照独有 dao hook → SNAP_ONLY", hasHard(r, "SNAP_ONLY", "hook:dao-rhythm.js"), JSON.stringify(hardIds(r)));
  check("快照独有 dao hook → 不误产 LIVE_ONLY", !r.hard.some((f) => f.kind === "LIVE_ONLY"), JSON.stringify(hardIds(r)));
  check("提醒含 ⬇ 方向标", lines.some((l) => l.startsWith("⬇")), JSON.stringify(lines));
  check("提醒给出 ⬇ 专属修法（下行同步，且劝阻手改 live）",
    lines.some((l) => /dao\.bat/.test(l) && /不要手改/.test(l)), JSON.stringify(lines));
}

console.log("\n=== 正态 · 方向不可混淆：两个方向同时存在时必须分别成行 ===");
{
  const live = liveEquivalent();
  live.hooks.PostToolUse[0].hooks.push({ type: "command", command: 'node "' + REPO.replace(/\\/g, "/") + '/ccswitch/hooks/dao-only-in-live.js"', timeout: 10 });
  const snap = snapClaude();
  snap.hooks.UserPromptSubmit = [{ hooks: [{ type: "command", command: 'node "' + PH_PROJECT + '/ccswitch/hooks/dao-only-in-snap.js"', timeout: 10 }] }];
  const { r, lines } = runPair(live, snap);
  check("双向同时 → LIVE_ONLY 指向 live 侧那个", hasHard(r, "LIVE_ONLY", "hook:dao-only-in-live.js"), JSON.stringify(hardIds(r)));
  check("双向同时 → SNAP_ONLY 指向快照侧那个", hasHard(r, "SNAP_ONLY", "hook:dao-only-in-snap.js"), JSON.stringify(hardIds(r)));
  check("双向同时 → 提醒分两行、方向不混", lines.some((l) => l.startsWith("⬆")) && lines.some((l) => l.startsWith("⬇")), JSON.stringify(lines));
  const upLine = lines.find((l) => l.startsWith("⬆")) || "";
  const downLine = lines.find((l) => l.startsWith("⬇")) || "";
  check("⬆ 行不夹带 ⬇ 的条目", /dao-only-in-live/.test(upLine) && !/dao-only-in-snap/.test(upLine), upLine);
  check("⬇ 行不夹带 ⬆ 的条目", /dao-only-in-snap/.test(downLine) && !/dao-only-in-live/.test(downLine), downLine);
}

console.log("\n=== 正态 · 承重字面键 ===");
{
  const live = liveEquivalent();
  live.permissions.deny = ["Bash(grep:*)"]; // Grep-first 护栏被摘掉一条
  const { r } = runPair(live, snapClaude());
  check("deny 缺项 → SNAP_ONLY 硬报", hasHard(r, "SNAP_ONLY", "permissions.deny"), JSON.stringify(hardIds(r)));
}
{
  const live = liveEquivalent();
  live.permissions.allow = live.permissions.allow.concat(["Bash(curl:*)"]); // 宿主 always-allow 追加
  const { r, lines } = runPair(live, snapClaude());
  check("allow 追加 → 只软报，不进提醒（宿主会自动追加，硬报即噪音）",
    r.hard.length === 0 && r.findings.some((f) => f.tier === "soft" && f.id === "permissions.allow") && lines.length === 0,
    JSON.stringify(hardIds(r)) + " lines=" + JSON.stringify(lines));
}
{
  const live = liveEquivalent();
  live.statusLine.command = "node " + REPO.replace(/\\/g, "/") + "/ccswitch/statusline-experimental.js";
  const { r } = runPair(live, snapClaude());
  check("statusLine 指向别的脚本 → VALUE_DIFF", hasHard(r, "VALUE_DIFF", "statusLine.command"), JSON.stringify(hardIds(r)));
}
{
  const live = liveEquivalent();
  live.hooks.SessionStart[0].matcher = "startup|resume"; // 挂载点漂移
  const { r } = runPair(live, snapClaude());
  check("同 hook 挂载点漂移 → VALUE_DIFF", hasHard(r, "VALUE_DIFF", "hook:dao-scaffold-check.js"), JSON.stringify(hardIds(r)));
}

// ══════════════════════════════════════════════════════════════════════════
// F3（fortify2-20260726 刀F）：命令串全等判据 —— basename 判据的原盲区
// 原判据只比 basename + 挂载点 + timeout，故「同名但路径被改回旧值」三项全同 ⇒ 零发现。
// 实证：dao-timecode 的 DB 侧仍指 ~/.claude/hooks 副本（该副本层已被刀D 整体删除，
// 实测该文件已不存在），live/快照侧指仓库路径 —— 同步过去即得一个指向不存在文件的死 hook。
console.log("\n=== F3 正态：同名不同路径必须报出（basename 判据看不出的那一类）===");
{
  const live = liveEquivalent();
  // 只改路径：basename / 挂载点 / timeout 全部保持与快照一致
  live.hooks.Stop[0].hooks[0].command = 'node "' + REPO.replace(/\\/g, "/") + '/ccswitch/hooks/dao-timecode.js" claude';
  const { r, lines } = runPair(live, snapClaude());
  check("同名不同路径 → hook-cmd VALUE_DIFF 硬报",
    hasHard(r, "VALUE_DIFF", "hook-cmd:dao-timecode.js"), JSON.stringify(hardIds(r)));
  check("不与挂载点漂移混淆（不产 hook:dao-timecode.js）",
    !hasHard(r, "VALUE_DIFF", "hook:dao-timecode.js"), JSON.stringify(hardIds(r)));
  const d = (r.hard.find((f) => f.id === "hook-cmd:dao-timecode.js") || {}).detail || "";
  check("报文点名「脚本路径」不一致（而非笼统说命令串不同）", /脚本路径/.test(d), d);
  check("报文给出两侧真实路径，便于人判哪侧是现行真相",
    /ccswitch\/hooks\/dao-timecode\.js/.test(d) && /\.claude\/hooks\/dao-timecode\.js/.test(d), d);
  check("报文警示「同步过去即成静默死 hook」", /静默死/.test(d), d);
  check("进 SessionStart 提醒（⚙ 方向不定，需人判）", lines.some((l) => l.startsWith("⚙")), JSON.stringify(lines));
}
{
  // 路径相同、只有参数不同 ⇒ 也该报，但报文不该谎称是路径问题
  const live = liveEquivalent();
  live.hooks.Stop[0].hooks[0].command = 'node "' + HOME + '\\.claude\\hooks\\dao-timecode.js" codex';
  const { r } = runPair(live, snapClaude());
  check("同路径但参数不同 → 仍硬报", hasHard(r, "VALUE_DIFF", "hook-cmd:dao-timecode.js"), JSON.stringify(hardIds(r)));
  const d = (r.hard.find((f) => f.id === "hook-cmd:dao-timecode.js") || {}).detail || "";
  check("同路径不同参数 → 报文归因为「调用形态/参数」，不误指路径",
    /参数/.test(d) && !/\*\*脚本路径\*\*/.test(d), d);
}

console.log("\n=== F3 负控：同一文件的不同写法不许误报（护栏两侧代价都是真的）===");
{
  // 无引号 + 全反斜杠：与快照的「占位符 + 引号 + 混合分隔符」是同一个文件的不同写法
  const live = liveEquivalent();
  live.hooks.Stop[0].hooks[0].command = "node " + HOME.replace(/\//g, "\\") + "\\.claude\\hooks\\dao-timecode.js claude";
  const { r, lines } = runPair(live, snapClaude());
  check("仅引号/分隔符写法不同 → 零硬报", r.hard.length === 0, JSON.stringify(hardIds(r)));
  check("仅引号/分隔符写法不同 → 零提醒噪音", lines.length === 0, JSON.stringify(lines));
}
{
  // 路径大小写不同（Windows 路径大小写不敏感）⇒ 不许报
  const live = liveEquivalent();
  live.hooks.Stop[0].hooks[0].command = 'node "' + HOME.toUpperCase() + '\\.CLAUDE\\HOOKS\\DAO-TIMECODE.JS" claude';
  const { r } = runPair(live, snapClaude());
  check("路径大小写不同 → 零硬报（Windows 语义）",
    !r.hard.some((f) => f.id === "hook-cmd:dao-timecode.js"), JSON.stringify(hardIds(r)));
}
{
  // 多余空白 ⇒ 不许报
  const live = liveEquivalent();
  live.hooks.Stop[0].hooks[0].command = 'node   "' + HOME + '\\.claude\\hooks\\dao-timecode.js"    claude ';
  const { r } = runPair(live, snapClaude());
  check("多余空白 → 零硬报", r.hard.length === 0, JSON.stringify(hardIds(r)));
}
{
  // 第三方命令串变化不许被 F3 判据卷进来（归属判据仍是第一道闸）
  const live = liveEquivalent();
  live.hooks.PostToolUse[1] = { matcher: "*", hooks: [{ type: "command", command: '"C:/Other/Path/coffee-cli.exe" __hook --verbose' }] };
  const { r } = runPair(live, snapClaude());
  check("第三方命令串变化 → 不进 F3 硬报（归属判据先挡）",
    !r.hard.some((f) => /^hook-cmd:/.test(f.id)), JSON.stringify(hardIds(r)));
}

// ══════════════════════════════════════════════════════════════════════════
// issue #58 · 仓库根归一化（考古结论与判据见 settings-drift.js 的 compareDeployment 头注）
// 端到端跑 detect()，不是只测纯函数——这一面的病恰恰长在「快照侧占位符由谁展开」上，
// 而展开发生在读盘之后，纯函数测不到那一段。
const OTHER_ROOT = "d:/frank/wd-impl-archaeology";   // 另一个 checkout（worktree 的形状）
console.log("\n=== #58 负控：live 与快照仓库根不同（worktree 里跑）不许报 ===");
{
  // live 的每个 dao hook 都指向另一个 checkout，其余（挂载点 / timeout / 参数）逐字不变。
  // 这就是本批之前的 15 条假阳性：从 worktree 跑时快照的 ${PROJECT_ROOT} 展开成 worktree 根。
  const live = liveEquivalent();
  const swap = (c) => c.replace(new RegExp(REPO.replace(/\\/g, "/").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), OTHER_ROOT);
  live.hooks.SessionStart[0].hooks[0].command = swap(live.hooks.SessionStart[0].hooks[0].command);
  live.hooks.SessionStart[1].hooks[0].command = swap(live.hooks.SessionStart[1].hooks[0].command);
  live.hooks.PostToolUse[0].hooks[0].command = swap(live.hooks.PostToolUse[0].hooks[0].command);
  const { r, lines } = runPair(live, snapClaude());
  check("整份指向另一个 checkout → 零硬报（归一化生效）", r.hard.length === 0, JSON.stringify(hardIds(r)));
  check("整份指向另一个 checkout → 零提醒噪音", lines.length === 0, JSON.stringify(lines));
  // D1（#171）：结构前提先判，且判的方式是「红」不是「崩」——下面三条都读 roots。
  check("detect 返回 roots.live / roots.snap 两侧数组（结构前提；缺了它下面几条会以崩溃代替红）",
    rootsSideOf(r, "live") !== null && rootsSideOf(r, "snap") !== null, JSON.stringify(r.roots));
  check("被归一化掉的根仍被 detect 原样带出（信息不许凭空消失）",
    (rootsSideOf(r, "live") || []).some((x) => x.toLowerCase() === OTHER_ROOT) &&
    (rootsSideOf(r, "snap") || []).some((x) => x.toLowerCase() === REPO.replace(/\\/g, "/").toLowerCase()),
    JSON.stringify(r.roots));
  check("快照侧的根是**展开后**的真实路径，不是 ${PROJECT_ROOT} 字面量",
    (rootsSideOf(r, "snap") || []).length > 0 && !(rootsSideOf(r, "snap") || []).some((x) => /\$\{/.test(x)),
    JSON.stringify(r.roots));
}
{
  // 大小写不同的同一棵树不许被兜底逻辑误判成「多根」——那是本批要消灭的病在兜底里复发
  const live = liveEquivalent();
  const P = REPO.replace(/\\/g, "/");
  live.hooks.PostToolUse[0].hooks[0].command =
    'node "' + (P[0].toUpperCase() + P.slice(1)).toUpperCase() + '/ccswitch/hooks/dao-glob-gate.js"';
  const { r } = runPair(live, snapClaude());
  check("同一棵树大小写不同 → 不判多根（Windows 语义）",
    !r.hard.some((f) => /^hook-root:/.test(f.id)), JSON.stringify(hardIds(r)));
}

console.log("\n=== #58 正控：同一侧内部多根必须报（归一化代价的兜底，与上一节成对）===");
{
  // live 里混进一个从别的 checkout 注册来的 hook：那棵树一删就成静默死 hook。
  // 归一化把「两侧根不同」抹掉了，这一格只剩这条兜得住。
  const live = liveEquivalent();
  live.hooks.PostToolUse[0].hooks[0].command = 'node "' + OTHER_ROOT + '/ccswitch/hooks/dao-glob-gate.js"';
  const { r, lines } = runPair(live, snapClaude());
  check("live 内部两个仓库根 → hook-root:live 硬报", hasHard(r, "VALUE_DIFF", "hook-root:live"), JSON.stringify(hardIds(r)));
  const d = (r.hard.find((f) => f.id === "hook-root:live") || {}).detail || "";
  check("报文点名两个根（人要据此判该删哪一个）",
    d.toLowerCase().includes(OTHER_ROOT) && d.toLowerCase().includes(REPO.replace(/\\/g, "/").toLowerCase()), d);
  check("报文说明后果（那棵树一删就成静默死 hook）", /静默死 hook/.test(d), d);
  check("多根发现进得了 SessionStart 提醒（不许只在 CLI 里可见）",
    lines.some((l) => /仓库根/.test(l)), JSON.stringify(lines));
}
{
  // 快照侧内部多根 = 「有人从 worktree 导出过存档」唯一可能的痕迹形态（考古结论②）。
  // 本条把那次手工翻 git 全历史的考古机器化：真发生就当场报。
  const snap = snapClaude();
  snap.hooks.PostToolUse[0].hooks[0].command = 'node "' + OTHER_ROOT + '/ccswitch/hooks/dao-glob-gate.js"';
  const live = liveEquivalent();
  live.hooks.PostToolUse[0].hooks[0].command = 'node "' + OTHER_ROOT + '/ccswitch/hooks/dao-glob-gate.js"';
  const { r } = runPair(live, snap);
  check("快照内部两个仓库根 → hook-root:快照 硬报（存档被 worktree 污染的签名）",
    hasHard(r, "VALUE_DIFF", "hook-root:快照"), JSON.stringify(hardIds(r)));
}
{
  // 射程边界：归一化只吃 /ccswitch/ 这一段，~/.claude/hooks 形态必须仍然报得出来。
  // 上面 F3 那节已从另一个方向守着同一件事，这条是显式声明边界~~（放宽即红）~~。
  // 🔴 2026-08-07 订正（PR #167 对抗实测 A5，账 #171）：**「放宽即红」被证伪**——把
  // agnosticCommand(:1286) 的射程放宽到也吃 `.claude/hooks/`，本条**照绿**（两侧一个在
  // `<repo>/ccswitch/`、一个在 `<repo>/.claude/hooks/`，归一化之后仍然不等）。
  // 真正会被那次放宽吃掉的形态是「**两侧都在 .claude/hooks/、只是 HOME 前缀不同**」，
  // 由下面 A5 那节补上；本条守的是另一格（跨段），两条不可互相代替。
  const live = liveEquivalent();
  live.hooks.Stop[0].hooks[0].command = 'node "' + OTHER_ROOT + '/ccswitch/hooks/dao-timecode.js" claude';
  const { r } = runPair(live, snapClaude());
  check("快照在 ~/.claude/hooks、live 在某 checkout 的 ccswitch → 仍硬报（归一化没吃过界）",
    hasHard(r, "VALUE_DIFF", "hook-cmd:dao-timecode.js"), JSON.stringify(hardIds(r)));
}

// ══════════════════════════════════════════════════════════════════════════
// issue #171 批 A · 纯断言四笔（PR #167 对抗账里 6 个「全库零红」变体中的 4 个）
// 本节**只补断言、不改被测行为**：每一条都配了一个具体的、已实测过的破坏方式，
// 破坏点写在各条注释里（「钉 <文件>:<行> 那一格」），归因由 PR body 的红集表兑现。
// ══════════════════════════════════════════════════════════════════════════

console.log("\n=== #171 · F4：尾斜杠归一化（PR #167 合并前清偿的那一行，本批补它的正负控）===");
{
  // 钉 settings-drift.js:1386 的 `.replace(/\/+$/, "")`。
  // 病灶形态：repoRootsOf(:1312) 的裸捕获 `([^\s"']*)\/ccswitch\/` 遇到 `//ccswitch/`
  // （normCommand 头注自陈的第 ④ 类野外写法：重复斜杠）会把尾斜杠一起捕进来 ⇒ 同一棵树
  // 捕出「带尾斜杠」与「不带」两个根 ⇒ 多根兜底当场打两条硬报，而那是它自己造的假阳性。
  // 判据独立写死：期望值是手算的字面量，不由 lib 的任何函数生成。
  const got = lib.rootsOf(oneHookObj('node "D:/frank/wd-tail//ccswitch/hooks/dao-x.js"'));
  check("F4 正控① · 单个 `//ccswitch/` 的尾斜杠被抹掉（期望值手写死）",
    got.length === 1 && got[0] === "D:/frank/wd-tail", JSON.stringify(got));
}
{
  // 与①不同的样本、不同的谓词：这一条问的是「两种写法会不会被算成两棵树」。
  const got = lib.rootsOf({
    hooks: {
      SessionStart: [{ hooks: [
        { type: "command", command: 'node "D:/frank/wd-tail//ccswitch/hooks/dao-a.js"' },  // 重复斜杠写法
        { type: "command", command: 'node "D:/frank/wd-tail/ccswitch/hooks/dao-b.js"' },   // 常规写法
      ] }],
    },
  });
  check("F4 正控② · 同一棵树的 `//` 与 `/` 两种写法归一成一个根（不许自造多根）",
    got.length === 1 && got[0] === "D:/frank/wd-tail", JSON.stringify(got));
}
{
  // issue #171 点名的「`//` 与占位符混写」那一格：快照侧存的是 ${PROJECT_ROOT}，
  // rootsOf 先 decodePaths 再抹尾斜杠，两步的次序在这里才看得出来
  //（先抹后展开的话，`${PROJECT_ROOT}/` 这个尾斜杠还在占位符外面、抹得掉，
  // 但真正要抹的是展开之后那个 —— 两种次序在纯 `/` 写法上不可区分）。
  const got = lib.rootsOf({
    hooks: {
      SessionStart: [{ hooks: [
        { type: "command", command: 'node "' + PH_PROJECT + '//ccswitch/hooks/dao-a.js"' },
        { type: "command", command: 'node "' + PH_PROJECT + '/ccswitch/hooks/dao-b.js"' },
      ] }],
    },
  });
  check("F4 正控③ · 占位符 + `//` 混写仍归一成一个根", got.length === 1, JSON.stringify(got));
  check("F4 正控③ · 展开后的根不带尾斜杠（判据写死：末字符不是 `/`）",
    got.length === 1 && !/\/$/.test(got[0]), JSON.stringify(got));
  check("F4 正控③ · 展开出来的就是本 checkout 的根（用测试自己算的 REPO 对，不问 lib）",
    got.length === 1 && got[0].toLowerCase() === REPO.replace(/\\/g, "/").toLowerCase(), JSON.stringify(got));
}
{
  // 端到端：把同一个病放回真实报文路径上。三条断言刻意落在**三个不同的可观测面**上
  // ——① findings 集合 ② roots 报文 ③ SessionStart 提醒 —— 抹尾斜杠一坏，
  // 三面各自都会说话，红集因此指得出「坏在哪一面」，而不是三条同生同死。
  const live = liveEquivalent();
  const P = REPO.replace(/\\/g, "/");
  live.hooks.PostToolUse[0].hooks[0].command = 'node "' + P + '//ccswitch/hooks/dao-glob-gate.js"';
  const { r, lines } = runPair(live, snapClaude());
  check("F4 端到端 · 同一棵树的 `//` 写法 → 零硬报（不许把重复斜杠当成第二个 checkout）",
    r.hard.length === 0, JSON.stringify(hardIds(r)));
  check("F4 端到端 · roots 报文只打一个根、且不带尾斜杠",
    (rootsSideOf(r, "live") || []).length === 1 && !/\/$/.test((rootsSideOf(r, "live") || [""])[0]),
    JSON.stringify(r.roots));
  check("F4 端到端 · 零提醒噪音（假阳性会每次进项目都唠叨一遍，检查器随即被人删掉）",
    lines.length === 0, JSON.stringify(lines));
}

console.log("\n=== #171 · A5：归一化的射程上界（只吃 /ccswitch/，不许吃 .claude/hooks/）===");
{
  // 钉 settings-drift.js:1280-1281 头注写死的契约 + :1286 那条正则的射程。
  // 头注原话：「归一化只吃 `/ccswitch/` 这一段：`${HOME}/.claude/hooks/` 形态的路径不受影响
  //（HOME 是机器级的，两侧展开一致），所以『hook 被改回旧的 ~/.claude 副本』仍报得出。」
  // 这句契约此前**零断言**：把 :1286 放宽到也吃 `.claude/hooks/`，全库零红（PR #167 对抗 A5）。
  // 原因是既有的两条守卫（上面「射程边界」那条、F3 那节）比的都是**跨段**形态
  //（一侧 ccswitch、一侧 .claude/hooks），放宽之后两侧仍不相等 ⇒ 照绿。
  // 唯一会被吃掉的是**同段不同前缀**：两侧都在 `.claude/hooks/`，只是 HOME 不同
  // —— 换机 / 换用户名之后导出的快照，正是这个形状，而它本该硬报。
  const live = liveEquivalent();
  live.hooks.Stop[0].hooks[0].command = 'node "C:/Users/OldUser/.claude/hooks/dao-timecode.js" claude';
  const { r, lines } = runPair(live, snapClaude());
  check("A5 · 两侧同在 .claude/hooks 但 HOME 前缀不同（换机/换用户名）→ 仍硬报",
    hasHard(r, "VALUE_DIFF", "hook-cmd:dao-timecode.js"), JSON.stringify(hardIds(r)));
  const d = (r.hard.find((f) => f.id === "hook-cmd:dao-timecode.js") || {}).detail || "";
  check("A5 · 报文同时打出两侧的真实 HOME 前缀（人要据此判哪一侧是本机）",
    /olduser/i.test(d) && d.toLowerCase().includes(HOME.toLowerCase()), d);
  check("A5 · 该发现进得了 SessionStart 提醒（不许只在 CLI 全量输出里可见）",
    lines.some((l) => l.startsWith("⚙")), JSON.stringify(lines));
  // 配套的另一侧（「HOME 前缀相同 ⇒ 零报」）已由本文件开头「一致 → 零硬发现」那条守着：
  // 基础夹具的 Stop hook 两侧就是同一个 HOME 下的 .claude/hooks，此处不重复造。
}

console.log("\n=== #171 · E2：根发现的次序意图（hookLines 只展示前 3 条 detail）===");
{
  // 钉两格：compareDeployment(:1410) 的 `rootFindings.concat(...)` 前置，
  // 与 hookLines(:1076) 的 `diff.slice(0, 3)` 截断。
  // 这两格是一对契约：截断存在 ⇒ 次序就是「谁进得了提醒」的判据。发现数 ≤3 时两者
  // 观察不出差别，所以本节先立一条**前提断言**保证夹具真的越过了 3 这条线。
  const P = REPO.replace(/\\/g, "/");
  const live = liveEquivalent();
  live.hooks.PostToolUse[0].hooks[0].command = 'node "' + OTHER_ROOT + '/ccswitch/hooks/dao-glob-gate.js"'; // ① 多根
  live.hooks.SessionStart[0].matcher = "startup|resume";                                                   // ② 挂载点漂移
  live.hooks.Stop[0].hooks[0].command = 'node "' + HOME + '\\.claude\\hooks\\dao-timecode.js" codex';       // ③ 命令串参数
  live.statusLine.command = "node " + P + "/ccswitch/statusline-experimental.js";                           // ④ statusLine
  live.permissions.defaultMode = "acceptEdits";                                                             // ⑤ defaultMode
  const { r, lines } = runPair(live, snapClaude());
  const diff = r.hard.filter((f) => f.kind === "VALUE_DIFF");
  check("E2 前提 · 本夹具的 VALUE_DIFF 条数 >3（不越线则下面两条恒真、零判别力）",
    diff.length > 3, JSON.stringify(diff.map((f) => f.id)));
  check("E2 · 根发现排在 VALUE_DIFF 队首（钉 :1410 的 rootFindings 前置）",
    diff.length > 0 && diff[0].id === "hook-root:live", JSON.stringify(diff.map((f) => f.id)));
  check("E2 · 根发现落在被展示的前 3 条之内（钉 :1076 的 diff.slice(0, 3)）",
    diff.slice(0, 3).some((f) => f.id === "hook-root:live"), JSON.stringify(diff.slice(0, 3).map((f) => f.id)));
  const gearLine = lines.find((l) => l.startsWith("⚙")) || "";
  check("E2 · ⚙ 提醒行里真的看得见「仓库根」（端到端，不只是数组次序对）",
    /仓库根/.test(gearLine), gearLine);
}

console.log("\n=== #171 · D1：detect 缺 roots 时测试端判红而不是崩掉 ===");
{
  // 上面 #58 负控那节已经把「结构前提」那条断言挂上了。这里验的是**取值器本身**——
  // 它是那条断言的判别力来源，用合成样本直测，不碰真 detect（判据独立写死）。
  // 为什么这值得单立：原先每处直读 `r.roots.live`，detect 一旦不返回 roots
  // 就是 TypeError 终止进程 ⇒ 后 40 条一条不跑，而退出码与「红得对」完全一样。
  check("D1 · 缺 roots 键 → 取值器返回 null（不抛）", rootsSideOf({}, "live") === null);
  check("D1 · roots 在但该侧缺 → 返回 null（不抛）", rootsSideOf({ roots: {} }, "live") === null);
  check("D1 · 该侧不是数组 → 返回 null（不抛）", rootsSideOf({ roots: { live: "D:/x" } }, "live") === null);
  check("D1 · 整个结果为 null/undefined → 返回 null（不抛）",
    rootsSideOf(null, "live") === null && rootsSideOf(undefined, "snap") === null);
  check("D1 · 正常结构 → 原样返回那个数组（不是拷贝、不是真值化）", (() => {
    const a = ["D:/x"];
    return rootsSideOf({ roots: { live: a, snap: [] } }, "live") === a &&
           rootsSideOf({ roots: { live: a, snap: [] } }, "snap") !== null;   // 空数组 ≠ 结构缺失
  })());
}

console.log("\n=== #171 · 已知边界（钉现状，不是背书；改行为要重做误报评估 —— 超本批射程）===");
{
  // ㈠ repoRootsOf(:1312) 的正则**没有 `/g`**，`match` 因此只取一条命令里的第一处 `/ccswitch/`。
  //    对照：agnosticCommand(:1286) 的同款正则**有 `/g`** —— 同一份数据，归一化那侧两处都吃，
  //    报文这侧只看见一处。当前仓不触发（没有哪条命令同时引用两棵树），故只钉现状。
  //    ⚠ 这两条断言在「有人给它补上 /g」时会红。那不是回归，是本条在提醒：
  //       改它之前要先重做误报评估（第二处捕获会不会把参数里的路径也算成根），见 issue #171。
  const got = lib.rootsOf(oneHookObj(
    'node "D:/frank/wd-alpha/ccswitch/hooks/dao-x.js" --rules "D:/frank/wd-beta/ccswitch/rules/r.json"'));
  check("边界㈠ · 一条命令里两个 /ccswitch/ → 现状只捕到第一个",
    got.length === 1 && got[0] === "D:/frank/wd-alpha", JSON.stringify(got));
  check("边界㈠ · 现状确实漏掉了第二棵树（把「漏的那一半」也钉住，别只钉「捕到的那一半」）",
    !got.some((x) => /wd-beta/i.test(x)), JSON.stringify(got));
}
{
  // ㈡ 字符类 `[^\s"']*` 遇空格即截断 ⇒ 含空格的根被砍成一个**盘上不存在的假根**，
  //    而 rootFindings 的报文会把它当「仓库根」原样打给人看（`C:/Program Files/wd` → `Files/wd`）。
  //    当前仓不触发（真根无空格），故同样只钉现状。
  const got = lib.rootsOf(oneHookObj('node "C:/Program Files/wd/ccswitch/hooks/dao-x.js"'));
  check("边界㈡ · 含空格的根被空格截断成假根（现状如此，且报文会照打这个假根）",
    got.length === 1 && got[0] === "Files/wd", JSON.stringify(got));
}

{
  const live = liveEquivalent();
  delete live.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
  const { r } = runPair(live, snapClaude());
  check("env 非密钥键缺失 → SNAP_ONLY 硬报", hasHard(r, "SNAP_ONLY", "env(键集)"), JSON.stringify(hardIds(r)));
}
{
  const live = liveEquivalent();
  live.env.ANTHROPIC_AUTH_TOKEN = "sk-changed-completely"; // 密钥值变 —— 快照侧是脱敏占位符，本就比不了
  const { r } = runPair(live, snapClaude());
  check("env 密钥值变化 → 不硬报（脱敏面已知盲区，不制造假阳性）", r.hard.length === 0, JSON.stringify(hardIds(r)));
}
{
  const live = liveEquivalent();
  live.permissions.additionalDirectories = [HOME + "\\.claude", "D:/somewhere/else"];
  const { r } = runPair(live, snapClaude());
  check("additionalDirectories 真的多一项 → LIVE_ONLY", hasHard(r, "LIVE_ONLY", "permissions.additionalDirectories"), JSON.stringify(hardIds(r)));
}
{
  const live = liveEquivalent();
  live.permissions.additionalDirectories = [HOME.replace(/\//g, "\\") + "\\.claude\\"]; // 反斜杠 + 尾斜杠
  const { r } = runPair(live, snapClaude());
  check("additionalDirectories 占位符/斜杠/尾斜杠差异 → 还原后视为等价，零报", r.hard.length === 0, JSON.stringify(hardIds(r)));
}

console.log("\n=== 自指 · 运行时功能探针 ===");
{
  const p = lib.runSelfProbe();
  check("探针自身通过", p.ok, JSON.stringify(p.failed));
  check("探针断言条数达下限（真空守卫：探针被清空不许报绿）",
    p.total >= lib.MIN_PROBE_CHECKS, `total=${p.total} min=${lib.MIN_PROBE_CHECKS}`);
  check("探针同时含正例与负例", p.checks.some((c) => /^正例/.test(c.name)) && p.checks.some((c) => /^负例/.test(c.name)));
}
{
  // 探针失效时，detect 必须让「零发现」变得不可信，而不是安静报绿
  process.env.DAO_SETTINGS_DRIFT_FORCE_ERROR = "probe";
  const { r, lines } = runPair(liveEquivalent(), snapClaude());
  delete process.env.DAO_SETTINGS_DRIFT_FORCE_ERROR;
  check("探针出错 → probe.ok=false", r.probe.ok === false);
  check("探针出错 → 提醒明说「无漂移不可信」", lines.some((l) => /不可信/.test(l)), JSON.stringify(lines));
  check("探针出错 → 错误进 errors 而非被吞", r.errors.length > 0, JSON.stringify(r.errors));
}

console.log("\n=== 错误可见性：出错必须留痕，绝不静默 exit 0 式吞错 ===");
function errLogSize() {
  try { return fs.statSync(path.join(STATE, "errors.log")).size; } catch (_) { return 0; }
}
{
  const before = errLogSize();
  const { r, lines } = runPair(null, snapClaude(), { livePath: path.join(TMP, "does-not-exist.json") });
  check("live 文件不存在 → errors 非空", r.errors.length > 0, JSON.stringify(r.errors));
  check("live 文件不存在 → hookLines 有 ✗ 行（不静默）", lines.some((l) => l.startsWith("✗")), JSON.stringify(lines));
  check("live 文件不存在 → errors.log 增长", errLogSize() > before, `before=${before} after=${errLogSize()}`);
}
{
  const { r, lines } = runPair(liveEquivalent(), "{ 这不是合法 JSON {{{");
  check("快照 JSON 损坏 → errors 非空", r.errors.length > 0, JSON.stringify(r.errors));
  check("快照 JSON 损坏 → hookLines 有 ✗ 行", lines.some((l) => l.startsWith("✗")), JSON.stringify(lines));
}
{
  const doc = JSON.stringify({ source: "x", rows: [{ key: "common_config_codex", value: "toml" }] });
  const { r, lines } = runPair(liveEquivalent(), doc);
  check("快照缺 common_config_claude 行 → 报错而非当成空对象比", r.errors.length > 0, JSON.stringify(r.errors));
  check("快照缺 common_config_claude 行 → hookLines 有 ✗ 行", lines.some((l) => l.startsWith("✗")));
}
{
  process.env.DAO_SETTINGS_DRIFT_FORCE_ERROR = "compare";
  const { r, lines } = runPair(liveEquivalent(), snapClaude());
  delete process.env.DAO_SETTINGS_DRIFT_FORCE_ERROR;
  check("比对阶段故障闸 → errors 非空", r.errors.length > 0, JSON.stringify(r.errors));
  check("比对阶段故障闸 → 不冒充「零漂移」", lines.some((l) => l.startsWith("✗")), JSON.stringify(lines));
}
{
  // 关键反面教材断言：任何内部故障都不许让输出变空
  for (const stage of ["probe", "contract", "load", "compare"]) {
    process.env.DAO_SETTINGS_DRIFT_FORCE_ERROR = stage;
    const { lines } = runPair(liveEquivalent(), snapClaude());
    delete process.env.DAO_SETTINGS_DRIFT_FORCE_ERROR;
    check(`故障闸 @${stage} → 输出非空（不静默）`, lines.length > 0, JSON.stringify(lines));
  }
}

console.log("\n=== 心跳 · synthetic 标记（防自测把接线判定染绿）===");
{
  const firedPath = lib.firedLogPath();
  const before = fs.existsSync(firedPath) ? fs.readFileSync(firedPath, "utf8").split(/\r?\n/).filter(Boolean).length : 0;
  runPair(liveEquivalent(), snapClaude(), { real: true }); // 即便宣称 real=true
  const recs = fs.readFileSync(firedPath, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  check("心跳有写出", recs.length > before, `before=${before} after=${recs.length}`);
  check("SELFTEST=1 时即便 real:true 也强制标 synthetic（自测不许染绿）",
    recs.slice(before).every((r) => r.synthetic === true), JSON.stringify(recs.slice(before)));
  check("心跳记录带可判读的运行事实（耗时/探针/硬发现数）",
    recs[recs.length - 1].elapsedMs !== undefined &&
    recs[recs.length - 1].probeOk !== undefined &&
    recs[recs.length - 1].hard !== undefined, JSON.stringify(recs[recs.length - 1]));
}

console.log("\n=== 接线层：真跑 dao-scaffold-check.js（非阻断 + 故障可见）===");
{
  const payload = JSON.stringify({ session_id: "unit-test", hook_event_name: "SessionStart", source: "startup", cwd: REPO });
  const r = spawnSync(process.execPath, [SCAFFOLD_HOOK], {
    input: payload, encoding: "utf8",
    env: Object.assign({}, process.env, { DAO_SETTINGS_DRIFT_FORCE_ERROR: "1", DAO_SETTINGS_DRIFT_SELFTEST: "1" }),
  });
  check("检测器全线故障时 hook 仍 exit 0（不阻断用户进项目）", r.status === 0, "code=" + r.status);
  check("检测器全线故障时 hook 输出里能看到 ✗（不静默）", /✗/.test(r.stdout || ""), (r.stdout || "").slice(0, 300));
  check("检测器全线故障时 stderr 也留痕", /settings-drift/.test(r.stderr || ""), (r.stderr || "").slice(0, 300));
}
{
  const payload = JSON.stringify({ session_id: "unit-test", hook_event_name: "SessionStart", source: "startup", cwd: REPO });
  const r = spawnSync(process.execPath, [SCAFFOLD_HOOK], {
    input: payload, encoding: "utf8",
    env: Object.assign({}, process.env, { DAO_SETTINGS_DRIFT_SELFTEST: "1" }),
  });
  check("正常路径 hook exit 0", r.status === 0, "code=" + r.status);
  check("正常路径 hook 输出是合法 JSON 或空", (() => {
    const s = (r.stdout || "").trim();
    if (!s) return true;
    try { JSON.parse(s); return true; } catch (_) { return false; }
  })(), (r.stdout || "").slice(0, 300));
}
{
  // 手工拼的 payload（无 transcript_path）必须被判为 synthetic —— 否则冒烟测试会自己给自己发「已生效」证明
  const stateForWire = path.join(TMP, "state-wire");
  fs.rmSync(stateForWire, { recursive: true, force: true });
  const payload = JSON.stringify({ session_id: "unit-test", hook_event_name: "SessionStart", source: "startup", cwd: REPO });
  const env = Object.assign({}, process.env, { DAO_SETTINGS_DRIFT_STATE_DIR: stateForWire });
  delete env.DAO_SETTINGS_DRIFT_SELFTEST; // 特意不给自测豁免，只靠 payload 形状判定
  spawnSync(process.execPath, [SCAFFOLD_HOOK], { input: payload, encoding: "utf8", env });
  const fired = path.join(stateForWire, "fired.log");
  const recs = fs.existsSync(fired) ? fs.readFileSync(fired, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [];
  check("手拼 payload（缺 transcript_path）→ 心跳标 synthetic", recs.length > 0 && recs.every((x) => x.synthetic === true), JSON.stringify(recs));
}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
