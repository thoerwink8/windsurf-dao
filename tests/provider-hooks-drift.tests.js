// per-provider hooks 漂移 · 两态自证（issue #50）
//
// 跑法：node tests/provider-hooks-drift.tests.js   （全绿 exit 0，任一红 exit 1）
//
// ── 验的是哪一层 ────────────────────────────────────────────────────────────
// ① **纯函数层**（`compareProviderHooks`）：造 provider fixture → 断言正控被检出且点名到
//    具体脚本、负控零误报、自检半边在主解析瞎掉时仍看得见样本、零样本不许报成通过。
// ② **端到端层**（CLI + 临时 sqlite 文件）：证明「读 DB 这条路本身是通的」——
//    纯函数全绿只证明比对逻辑对，证不了它接得上真的 providers 表。
//    这一层**造一个真的 .db 文件**（临时目录，跑完删），**绝不碰真实 cc-switch DB**。
//
// ── 不证明什么（照直写）────────────────────────────────────────────────────
// 不证明这道检查会被谁跑到。接线由 `ccswitch/hooks/dao-scaffold-check.js` 模式 A 负责，
// 那一层的可达性只能由 dao-scaffold-check 自己的测试与真实 SessionStart 心跳证明。
//
// ── sqlite3 不在时怎么办 ────────────────────────────────────────────────────
// ② 那一层需要 sqlite3。找不到时**跳过并计入 SKIP 且大声打印**，不静默当成通过
//    ——「跑不了」和「跑了且过了」必须分得开，那正是本检查自己要治的病。

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, execFileSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const LIB = path.join(REPO, "ccswitch", "lib", "settings-drift.js");
const TMP = path.join(REPO, "_tmp", "provider-hooks-drift-tests");

// 自测心跳绝不许污染 --selfcheck 的接线判定（防自我染绿）——与 settings-drift.tests.js 同惯例。
process.env.DAO_SETTINGS_DRIFT_STATE_DIR = path.join(TMP, "state");
process.env.DAO_SETTINGS_DRIFT_SELFTEST = "1";
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const lib = require(LIB);
const { compareProviderHooks, providerExitCode, PROVIDER_APP_TYPE } = lib;

const PH_PROJECT = "$" + "{PROJECT_ROOT}";

let pass = 0, fail = 0, skip = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}
function skipped(name, why) { skip++; console.log(`  SKIP  ${name}  →  ${why}`); }

// ── fixture ────────────────────────────────────────────────────────────────
// canonical 用占位符形态（git 快照就长这样），provider 用展开态（DB 里就长这样）。
// 这一对本身是最重要的负控：真实数据每天都是这个形状，判错就是每次都误报。
const DEPLOY_ROOT = "D:/frank/windsurf-dao";

function canonicalObj() {
  return {
    hooks: {
      SessionStart: [
        { matcher: "startup", hooks: [{ type: "command", command: 'node "' + PH_PROJECT + '/ccswitch/hooks/dao-scaffold-check.js"', timeout: 10 }] },
        { matcher: "startup|clear|resume", hooks: [{ type: "command", command: 'node "' + PH_PROJECT + '/ccswitch/hooks/dao-remove-session.js"', timeout: 5 }] },
      ],
      PostCompact: [{ hooks: [{ type: "command", command: 'node "' + PH_PROJECT + '/ccswitch/hooks/dao-compact-log.js"', timeout: 10 }] }],
      PreToolUse: [{ matcher: "Bash|Edit|Write", hooks: [{ type: "command", command: 'node "' + PH_PROJECT + '/ccswitch/hooks/dao-hard-gates.js"', timeout: 10 }] }],
    },
    statusLine: { type: "command", command: "node " + PH_PROJECT + "/ccswitch/statusline.js" },
  };
}

// provider 侧：展开态路径 + 各家自己的 env（本就该不同）
function providerObj(over) {
  const o = {
    env: { ANTHROPIC_BASE_URL: "https://alpha.example", ANTHROPIC_AUTH_TOKEN: "sk-alpha" },
    model: "opus[1m]",
    hooks: {
      SessionStart: [
        { matcher: "startup", hooks: [{ type: "command", command: 'node "' + DEPLOY_ROOT + '/ccswitch/hooks/dao-scaffold-check.js"', timeout: 10 }] },
        { matcher: "startup|clear|resume", hooks: [{ type: "command", command: 'node "' + DEPLOY_ROOT + '/ccswitch/hooks/dao-remove-session.js"', timeout: 5 }] },
      ],
      PostCompact: [{ hooks: [{ type: "command", command: 'node "' + DEPLOY_ROOT + '/ccswitch/hooks/dao-compact-log.js"', timeout: 10 }] }],
      PreToolUse: [{ matcher: "Bash|Edit|Write", hooks: [{ type: "command", command: 'node "' + DEPLOY_ROOT + '/ccswitch/hooks/dao-hard-gates.js"', timeout: 10 }] }],
    },
    statusLine: { type: "command", command: "node " + DEPLOY_ROOT + "/ccswitch/statusline.js" },
  };
  return over ? over(JSON.parse(JSON.stringify(o))) : o;
}

function row(id, name, over, appType) {
  return { id, name, app_type: appType || PROVIDER_APP_TYPE, settings_config: JSON.stringify(providerObj(over)) };
}

// #49 的原形：切 provider 时 PostCompact 被整体覆盖抹掉
const dropPostCompact = (s) => { delete s.hooks.PostCompact; return s; };

console.log("\n=== ① 纯函数层 · compareProviderHooks ===");

// ── 负控 ───────────────────────────────────────────────────────────────────
{
  const r = compareProviderHooks({ providers: [row("p1", "Alpha"), row("p2", "Beta")], canonical: canonicalObj() });
  check("负控·两 provider 与 canonical 全对齐（占位符 vs 展开态）→ exit 0",
    r.driftCount === 0 && r.crossCount === 0 && r.selfIssues.length === 0 && !r.uncheckable && providerExitCode(r) === 0,
    `drift=${r.driftCount} cross=${r.crossCount} self=${JSON.stringify(r.selfIssues)} exit=${providerExitCode(r)}`);
  check("负控·两半口径一致（statusLine 也进结构化计数，不报假扫描面塌陷）",
    r.scoped.every((s) => s.structural === s.census && s.structural === 5),
    JSON.stringify(r.scoped.map((s) => `${s.structural}/${s.census}`)));
}
{
  // provider 之间 env / model / 密钥不同：设计如此，报了就是每天唠叨
  const providers = [row("p1", "Alpha"), row("p2", "Beta", (s) => {
    s.env.ANTHROPIC_BASE_URL = "https://beta.example";
    s.env.ANTHROPIC_AUTH_TOKEN = "sk-beta";
    s.model = "claude-fable-5[1m]";
    return s;
  })];
  const r = compareProviderHooks({ providers, canonical: canonicalObj() });
  check("负控·provider 间 env/model/密钥不同 → 零漂移（hooks 面之外不管）",
    r.driftCount === 0 && r.crossCount === 0, `drift=${r.driftCount} cross=${r.crossCount}`);
}
{
  // 第三方 hook（别的工具往 live 注册的）：不进比对面，也不许被当成扫描面塌陷
  const providers = [row("p1", "Alpha"), row("p2", "Beta", (s) => {
    s.hooks.Stop = [{ hooks: [{ type: "command", command: '"C:/Program Files/Third/party.exe" __hook' }] }];
    s.hooks.Notification = [{ hooks: [{ type: "command", command: 'node "C:/Program Files/OtherTool/their-hook.js"' }] }];
    return s;
  })];
  const r = compareProviderHooks({ providers, canonical: canonicalObj() });
  check("负控·第三方 hook 不误伤且不误判扫描面塌陷",
    r.driftCount === 0 && r.crossCount === 0 && r.selfIssues.length === 0,
    `drift=${r.driftCount} cross=${r.crossCount} self=${JSON.stringify(r.selfIssues)}`);
}
{
  // 非 claude 型 provider：本机 13 行里有 11 行是这种，拉进来就是 11 条恒定噪音
  const providers = [row("p1", "Alpha"), row("p2", "Beta"),
    { id: "d1", name: "Desktop", app_type: "claude-desktop", settings_config: JSON.stringify({ env: { CLAUDE_CODE_ATTRIBUTION_HEADER: "0" } }) },
    { id: "c1", name: "Codex", app_type: "codex", settings_config: JSON.stringify({ auth: {}, config: { model: "gpt" } }) },
    { id: "g1", name: "Gemini", app_type: "gemini", settings_config: JSON.stringify({ env: {}, config: {} }) }];
  const r = compareProviderHooks({ providers, canonical: canonicalObj() });
  check("负控·非 claude 型 provider 不进比对面、零噪音，但分布如实打印",
    r.driftCount === 0 && r.crossCount === 0 && r.skipped.length === 3 && r.notes.length === 0 &&
    r.appTypeCounts.claude === 2 && r.appTypeCounts["claude-desktop"] === 1,
    `skipped=${r.skipped.length} notes=${JSON.stringify(r.notes)} dist=${JSON.stringify(r.appTypeCounts)}`);
}
{
  // 从 worktree 里跑：canonical 的 ${PROJECT_ROOT} 展开成 worktree 根，DB 里是主树根。
  // 这是**首跑真数据当场撞到的 26 条假阳性**，钉死在这里。
  const other = "D:/some/other/checkout/windsurf-dao";
  const swapRoot = (s) => {
    const j = JSON.stringify(s).split(DEPLOY_ROOT).join(other);
    return JSON.parse(j);
  };
  const providers = [row("p1", "Alpha", swapRoot), row("p2", "Beta", swapRoot)];
  const r = compareProviderHooks({ providers, canonical: canonicalObj() });
  check("负控·仓库根前缀不同（worktree 里跑）→ 面①零假阳性",
    r.driftCount === 0 && r.crossCount === 0, `drift=${r.driftCount}`);
  check("负控·被归一化掉的仓库根仍如实打印出来（信息不许凭空消失）",
    r.repoRoots.length === 1 && r.repoRoots[0] === other, JSON.stringify(r.repoRoots));
}

// ── 正控 ───────────────────────────────────────────────────────────────────
{
  const providers = [row("p1", "Alpha"), row("p2", "Beta", dropPostCompact)];
  const r = compareProviderHooks({ providers, canonical: canonicalObj() });
  check("正控·#49 原形（某 provider 少了 PostCompact）→ 面①报 CANONICAL_ONLY 且点名脚本+provider",
    r.vsCanonical.some((f) => f.kind === "CANONICAL_ONLY" && f.id === "hook:dao-compact-log.js" && /Beta/.test(f.provider)),
    JSON.stringify(r.vsCanonical.map((x) => `${x.provider}/${x.kind}:${x.id}`)));
  check("正控·同一漂移面②也报（provider 互比这一面独立成立）",
    r.crossProvider.some((c) => c.script === "dao-compact-log.js" && c.missing.some((m) => /Beta/.test(m))),
    JSON.stringify(r.crossProvider.map((c) => `${c.script} missing=${c.missing.join(",")}`)));
  check("正控·退出码 = 1（有差异）", providerExitCode(r) === 1, String(providerExitCode(r)));
}
{
  const providers = [row("p1", "Alpha"), row("p2", "Beta", (s) => {
    s.hooks.SessionStart[0].matcher = "resume"; return s;
  })];
  const r = compareProviderHooks({ providers, canonical: canonicalObj() });
  check("正控·挂载点(matcher)漂移 → 面①VALUE_DIFF + 面②cross",
    r.vsCanonical.some((f) => f.kind === "VALUE_DIFF" && f.id === "hook:dao-scaffold-check.js") &&
    r.crossProvider.some((c) => c.script === "dao-scaffold-check.js"),
    `vs=${JSON.stringify(r.vsCanonical.map((x) => x.kind + ":" + x.id))} cross=${JSON.stringify(r.crossProvider.map((c) => c.script))}`);
}
{
  // basename 判据的原盲区：同名但指回已被删掉的 ~/.claude/hooks 副本
  const providers = [row("p1", "Alpha"), row("p2", "Beta", (s) => {
    s.hooks.PostCompact[0].hooks[0].command = 'node "' + os.homedir().replace(/\\/g, "/") + '/.claude/hooks/dao-compact-log.js"';
    return s;
  })];
  const r = compareProviderHooks({ providers, canonical: canonicalObj() });
  check("正控·同名不同路径（~/.claude 旧副本）→ 面①hook-cmd VALUE_DIFF 且点名「脚本路径」",
    r.vsCanonical.some((f) => f.id === "hook-cmd:dao-compact-log.js" && /脚本路径/.test(f.detail)),
    JSON.stringify(r.vsCanonical.map((x) => x.kind + ":" + x.id)));
}
{
  const providers = [row("p1", "Alpha"), row("p2", "Beta", (s) => {
    s.hooks.PreToolUse[0].hooks[0].timeout = 120; return s;
  })];
  const r = compareProviderHooks({ providers, canonical: canonicalObj() });
  check("正控·timeout 漂移 → 报出且计入 drift（不因为「只是软的」而消失）",
    r.vsCanonical.some((f) => f.id === "hook-timeout:dao-hard-gates.js") && providerExitCode(r) === 1,
    JSON.stringify(r.vsCanonical.map((x) => x.tier + "/" + x.id)));
}
{
  // provider 多出一个 canonical 里没有的 dao hook（新 provider 自带私货 / canonical 陈旧）
  const providers = [row("p1", "Alpha"), row("p2", "Beta", (s) => {
    s.hooks.Stop = [{ hooks: [{ type: "command", command: 'node "' + DEPLOY_ROOT + '/ccswitch/hooks/dao-timecode.js" claude', timeout: 5 }] }];
    return s;
  })];
  const r = compareProviderHooks({ providers, canonical: canonicalObj() });
  check("正控·provider 多出 canonical 没有的 dao hook → PROVIDER_ONLY",
    r.vsCanonical.some((f) => f.kind === "PROVIDER_ONLY" && f.id === "hook:dao-timecode.js"),
    JSON.stringify(r.vsCanonical.map((x) => x.kind + ":" + x.id)));
}
{
  // 面①的归一化代价的兜底证明：两 provider 指着不同 checkout，面①看不见、面②必须报
  const providers = [row("p1", "Alpha"), row("p2", "Beta", (s) => {
    s.hooks.PostCompact[0].hooks[0].command = 'node "D:/old/windsurf-dao/ccswitch/hooks/dao-compact-log.js"';
    return s;
  })];
  const r = compareProviderHooks({ providers, canonical: canonicalObj() });
  check("正控·两 provider 指向不同 checkout → 面①看不见（归一化代价）但面②报出",
    r.driftCount === 0 && r.crossProvider.some((c) => c.script === "dao-compact-log.js"),
    `drift=${r.driftCount} cross=${JSON.stringify(r.crossProvider.map((c) => c.script))}`);
}

// ── 「没查成」≠「查了没事」──────────────────────────────────────────────────
{
  const r = compareProviderHooks({ providers: [{ id: "c1", name: "Codex", app_type: "codex", settings_config: "{}" }], canonical: canonicalObj() });
  check("零样本·没有 claude 型 provider → uncheckable 且 exit=2（不是 0）",
    r.uncheckable === true && providerExitCode(r) === 2 && r.notes.some((n) => /零样本/.test(n)),
    `uncheckable=${r.uncheckable} exit=${providerExitCode(r)} notes=${JSON.stringify(r.notes)}`);
}
{
  const r = compareProviderHooks({ providers: [], canonical: canonicalObj() });
  check("零行·providers 表为空 → exit=2", providerExitCode(r) === 2 && r.uncheckable, String(providerExitCode(r)));
}
{
  const providers = [row("p1", "Alpha"), row("p2", "Beta", dropPostCompact)];
  const r = compareProviderHooks({ providers, canonical: null });
  check("canonical 缺失·面①没查成 → uncheckable=true，但面②仍答话（exit=1 由真差异定）",
    r.canonicalOk === false && r.uncheckable === true && r.crossCount > 0 && providerExitCode(r) === 1,
    `canonicalOk=${r.canonicalOk} cross=${r.crossCount} exit=${providerExitCode(r)}`);
}
{
  const providers = [row("p1", "Alpha"), { id: "bad", name: "Broken", app_type: PROVIDER_APP_TYPE, settings_config: '{"hooks": ' }];
  const r = compareProviderHooks({ providers, canonical: canonicalObj() });
  check("坏 JSON·settings_config 解析不动 → uncheckable，绝不静默当成对齐",
    r.uncheckable === true && r.notes.some((n) => /解析失败/.test(n)) && providerExitCode(r) === 2,
    `uncheckable=${r.uncheckable} exit=${providerExitCode(r)}`);
}

// ── 自检半边：主解析瞎掉时仍看得见样本（守卫铁律②的可执行形式）────────────────
{
  // mutation：把 hooks 键改名 = 主解析什么都遍历不到，而独立普查仍在原始文本上数得到
  const blinded = JSON.stringify({ hooksV2: providerObj().hooks });
  const r = compareProviderHooks({ providers: [{ id: "p1", name: "Alpha", app_type: PROVIDER_APP_TYPE, settings_config: blinded }], canonical: canonicalObj() });
  check("自检·hooks 键被改名（主解析瞎掉）→ 报 undercount 扫描面塌陷 + exit=1",
    r.selfIssues.some((s) => /undercount@/.test(s)) && providerExitCode(r) === 1,
    `self=${JSON.stringify(r.selfIssues)} exit=${providerExitCode(r)}`);
}
{
  // 反向：普查这一半若与主逻辑共用解析，这条测不出东西。用「结构完好但普查看得见更多」
  // 的形状再钉一次：settings_config 里塞一段被转义的嵌套配置（快照层就是这个形态）。
  const obj = providerObj();
  obj.notes = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node x.js" }] }] } });
  const r = compareProviderHooks({ providers: [{ id: "p1", name: "Alpha", app_type: PROVIDER_APP_TYPE, settings_config: JSON.stringify(obj) }], canonical: canonicalObj() });
  check("自检·嵌在字符串里的 command 条目被普查看见（钝的方向是高估，宁可误报）",
    r.selfIssues.some((s) => /undercount@/.test(s)),
    `self=${JSON.stringify(r.selfIssues)} counts=${JSON.stringify(r.scoped.map((s) => s.structural + "/" + s.census))}`);
}

// ── 探针真空守卫：断言条数不许被削 ─────────────────────────────────────────
{
  const probe = lib.runSelfProbe();
  check(`探针·runSelfProbe ${probe.total} 条全过且 ≥ 下限 ${lib.MIN_PROBE_CHECKS}`,
    probe.ok && probe.total >= lib.MIN_PROBE_CHECKS,
    `ok=${probe.ok} total=${probe.total} failed=${JSON.stringify(probe.failed.map((f) => f.name))}`);
}

// ══════════════════════════════════════════════════════════════════════════
console.log("\n=== ② 端到端层 · CLI + 临时 sqlite（绝不碰真实 cc-switch DB）===");

function writeCanonicalFile(file, obj) {
  fs.writeFileSync(file, JSON.stringify({ rows: [{ key: "common_config_claude", value: JSON.stringify(obj) }] }, null, 2), "utf8");
}

function runCli(args) {
  const r = spawnSync(process.execPath, [LIB, "--providers", ...args], { encoding: "utf8", cwd: REPO });
  const out = String(r.stdout || "");
  const m = /PROVIDER_HOOKS_SUMMARY exit=(\d+) providers=(\d+) scoped=(\d+) drift=(\d+) cross=(\d+) selfcheck=(ok|fail) uncheckable=(\d+)/.exec(out);
  return { code: r.status, out, err: String(r.stderr || ""), summary: m ? { exit: m[1], providers: m[2], scoped: m[3], drift: m[4], cross: m[5], selfcheck: m[6], uncheckable: m[7] } : null };
}

function makeDb(file, rows) {
  const sqlite = sqlite3Path;
  const stmts = ['CREATE TABLE "providers" ("id" TEXT PRIMARY KEY, "app_type" TEXT, "name" TEXT, "settings_config" TEXT);'];
  for (const r of rows) {
    const lit = (v) => (v == null ? "NULL" : `'${String(v).split("'").join("''")}'`);
    stmts.push(`INSERT INTO "providers" ("id","app_type","name","settings_config") VALUES (${lit(r.id)}, ${lit(r.app_type)}, ${lit(r.name)}, ${lit(r.settings_config)});`);
  }
  execFileSync(sqlite, [file], { input: stmts.join("\n"), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

let sqlite3Path = null;
(async () => {
  try {
    const mod = await import("file://" + path.join(REPO, "config-sync", "lib", "sqlite.mjs").replace(/\\/g, "/"));
    sqlite3Path = mod.findSqlite3();
  } catch (e) {
    sqlite3Path = null;
    console.log(`  ⚠ 找不到 sqlite3（${e && e.message ? e.message : e}）—— 端到端层整块跳过，**这不等于通过**`);
  }

  const canonFile = path.join(TMP, "canonical.json");
  writeCanonicalFile(canonFile, canonicalObj());

  if (!sqlite3Path) {
    for (const n of ["端到端·全对齐 → exit 0", "端到端·人为制造漂移 → exit 1 且点名脚本",
      "端到端·DB 不存在 → exit 2 且末行仍打印", "端到端·providers 表不存在 → exit 2",
      "端到端·--providers 模式一个字节都不落盘"]) skipped(n, "sqlite3 不可用");
  } else {
    // ── 负控（端到端）：两 provider + canonical 全对齐 ──────────────────────
    const okDb = path.join(TMP, "aligned.db");
    makeDb(okDb, [row("p1", "Alpha"), row("p2", "Beta"),
      { id: "d1", app_type: "claude-desktop", name: "Desktop", settings_config: JSON.stringify({ env: {} }) }]);
    {
      const r = runCli(["--db-file", okDb, "--canonical-file", canonFile]);
      check("端到端·全对齐 → exit 0",
        r.code === 0 && r.summary && r.summary.exit === "0" && r.summary.drift === "0" &&
        r.summary.cross === "0" && r.summary.selfcheck === "ok" && r.summary.uncheckable === "0",
        `code=${r.code} summary=${JSON.stringify(r.summary)}`);
    }

    // ── 正控（端到端）：人为制造一次 provider hooks 漂移 ────────────────────
    // 这就是 issue #50 关闭条件里那句「用一次人为制造的漂移做正控验证过」。
    const driftDb = path.join(TMP, "drifted.db");
    makeDb(driftDb, [row("p1", "Alpha"), row("p2", "Beta", dropPostCompact)]);
    {
      const r = runCli(["--db-file", driftDb, "--canonical-file", canonFile]);
      check("端到端·人为制造漂移 → exit 1 且点名脚本",
        r.code === 1 && r.summary && r.summary.exit === "1" && Number(r.summary.drift) > 0 &&
        Number(r.summary.cross) > 0 && /dao-compact-log\.js/.test(r.out) && /Beta/.test(r.out),
        `code=${r.code} summary=${JSON.stringify(r.summary)}`);
      check("端到端·漂移报文点明「切到这个 provider 就会被静默抹掉」（说出后果，不只报差异）",
        /静默抹掉|静默消失/.test(r.out), r.out.slice(0, 400));
      const j = runCli(["--db-file", driftDb, "--canonical-file", canonFile, "--json"]);
      let parsed = null;
      try { parsed = JSON.parse(j.out.slice(0, j.out.lastIndexOf("}") + 1)); } catch (_) {}
      check("端到端·--json 输出可解析且带 vsCanonical / crossProvider 明细",
        parsed && Array.isArray(parsed.vsCanonical) && parsed.vsCanonical.length > 0 &&
        Array.isArray(parsed.crossProvider) && parsed.crossProvider.length > 0,
        parsed ? JSON.stringify(Object.keys(parsed)) : j.out.slice(0, 200));
    }

    // ── 「没查成」必须与「查了没事」分得开 ─────────────────────────────────
    {
      const r = runCli(["--db-file", path.join(TMP, "does-not-exist.db"), "--canonical-file", canonFile]);
      check("端到端·DB 不存在 → exit 2 且末行仍打印（不许「什么都没说」）",
        r.code === 2 && r.summary && r.summary.exit === "2" && r.summary.uncheckable === "1",
        `code=${r.code} summary=${JSON.stringify(r.summary)} out=${r.out.slice(0, 200)}`);
    }
    {
      const emptyDb = path.join(TMP, "no-table.db");
      execFileSync(sqlite3Path, [emptyDb], { input: 'CREATE TABLE "other" ("x" TEXT);\n', encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
      const r = runCli(["--db-file", emptyDb, "--canonical-file", canonFile]);
      check("端到端·providers 表不存在 → exit 2（不是 0）",
        r.code === 2 && r.summary && r.summary.exit === "2" && r.summary.uncheckable === "1",
        `code=${r.code} summary=${JSON.stringify(r.summary)}`);
    }
    {
      const r = runCli(["--db-file", okDb, "--canonical-file", path.join(TMP, "no-canonical.json")]);
      check("端到端·canonical 读不到 → exit 2 且明说「本次没查成」",
        r.code === 2 && r.summary && r.summary.uncheckable === "1" && /没查成/.test(r.out),
        `code=${r.code} summary=${JSON.stringify(r.summary)}`);
    }

    // ── 守卫铁律③：检查器的输出不能落进它自己的扫描面 ─────────────────────
    {
      const stateDir = path.join(TMP, "state-probe");
      fs.rmSync(stateDir, { recursive: true, force: true });
      const before = fs.existsSync(stateDir) ? fs.readdirSync(stateDir) : [];
      const r = spawnSync(process.execPath, [LIB, "--providers", "--db-file", okDb, "--canonical-file", canonFile],
        { encoding: "utf8", cwd: REPO, env: Object.assign({}, process.env, { DAO_SETTINGS_DRIFT_STATE_DIR: stateDir }) });
      const after = fs.existsSync(stateDir) ? fs.readdirSync(stateDir) : [];
      check("端到端·--providers 模式一个字节都不落盘（报告不可能落进自己的扫描面）",
        r.status === 0 && after.length === 0 && before.length === 0,
        `code=${r.status} before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
    }
  }

  console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} SKIP=${skip} ===`);
  if (skip > 0) console.log("  ⚠ 有跳过项：跳过不是通过，上面每条 SKIP 都写了原因");
  process.exit(fail === 0 ? 0 : 1);
})();
