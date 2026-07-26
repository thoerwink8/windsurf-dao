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
