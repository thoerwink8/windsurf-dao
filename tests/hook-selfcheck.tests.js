// hook-selfcheck 公共库自证 · 单元级（每个行为分支留正控 + 负控）
//
// 为什么单独给库补测：selfcheckLines 是文案模板，改坏了 hook 的行为测试不会红
// （F1 重构时真踩过一次：`因 ${missNote}不匹配` 多打一个空格，两套 hook 测试全绿）。
// 心跳半段逐字锚定（logPath 可注入 ⇒ 确定性）；注册半段读真实 live settings.json，
// 只断言两种形态之一与格式骨架，不锚定内容（否则测试随用户配置变红）。
// ⚠ 注册半段在云审 runner 上会因没有 ~/.claude/settings.json 而整段红（issue #308）——
//   故把 USERPROFILE/HOME 在 require 前指到假家目录，注册核验变成可注入、可确定。

const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const TMP = path.join(REPO, "_tmp", "knifeF-hook-selfcheck-tests");
const FAKE_HOME = path.join(TMP, "fake-home");
process.env.USERPROFILE = FAKE_HOME;
process.env.HOME = FAKE_HOME;
const lib = require("../ccswitch/lib/hook-selfcheck.js");

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}

// 与 dao-rule-echo.js 实际传入的一致，便于「库改了但 hook 没改」时也能看出来
function ruleEchoSc(logPath) {
  return {
    event: "PostToolUse",
    scriptName: "dao-rule-echo.js",
    covers: (m) => m === "*" || (/Edit/.test(m) && /Write/.test(m)),
    matcherLabel: (m) => m,
    coversFailNote: " —— 该 matcher 未同时覆盖 Edit/Write，规则写入可能漏触发",
    logPath,
    missNote: "matcher/路径判据",
    describeLast: (last) => `${last.tool} · ${last.file}`,
    staleDays: 30,
    staleNote: (d) => `⚠ 末次真实触发距今 ${d} 天；若期间改过规则文件，说明已失联，请核 settings.json 注册。`,
    logReadFailLabel: "心跳日志读取失败",
  };
}

const H = lib.createHookScaffold({
  name: "knifeF-probe",
  stateSubdir: "knifeF-hook-selfcheck-tests/state",
  failTail: "本次啥也没干",
  forceErrorEnv: "KNIFEF_PROBE_FORCE_ERROR",
  selfTestEnv: "KNIFEF_PROBE_SELFTEST",
});

function writeJsonl(name, recs) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, recs.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n", "utf8");
  return p;
}

console.log("\n=== 心跳半段 · 无真实记录（逐字锚定 F1 踩过的空白 bug）===");
{
  const logPath = writeJsonl("empty-real.jsonl", [
    { at: "2026-07-26T00:00:00.000Z", synthetic: true },
    { at: "2026-07-26T00:00:01.000Z", synthetic: true },
  ]);
  const hb = H.selfcheckLines(ruleEchoSc(logPath)).lines.at(-1);
  const expected =
    "✗ 无真实触发记录（日志共 2 条，其中自测/手工 2 条）—— " +
    "尚未被宿主真实调用过；注册了也可能因 matcher/路径判据不匹配而从未触发。日志：" + logPath;
  check("无真实记录行逐字符一致（含「判据不匹配」无多余空格）+ 自测心跳不被采信 + bad≥1",
    hb === expected && !/判据 不匹配/.test(hb) && /尚未被宿主真实调用过/.test(hb) &&
    H.selfcheckLines(ruleEchoSc(logPath)).bad >= 1,
    "\n    实得: " + JSON.stringify(hb));
  check("日志文件不存在 → 报「共 0 条」而非崩",
    /日志共 0 条/.test(H.selfcheckLines(ruleEchoSc(path.join(TMP, "nope.jsonl"))).lines.at(-1)));
}

console.log("\n=== 心跳半段 · 有真实记录 + 陈旧告警 + 坏行容错 ===");
{
  const logPath = writeJsonl("has-real.jsonl", [
    { at: "2026-07-26T00:00:00.000Z", synthetic: true },
    { at: new Date(Date.now() - 2 * 86400000).toISOString(), tool: "Edit", file: "D:/x/CLAUDE.md" },
  ]);
  const hb = H.selfcheckLines(ruleEchoSc(logPath)).lines.at(-1);
  check("有真实记录 → ✓ 行，describeLast 插值 + 真实/总数计数正确",
    /^✓ 有真实触发记录/.test(hb) && /Edit · D:\/x\/CLAUDE\.md/.test(hb) && /真实 1 条 \/ 共 2 条/.test(hb), hb);
}
{
  const stale = writeJsonl("stale.jsonl", [
    { at: new Date(Date.now() - 40 * 86400000).toISOString(), tool: "Write", file: "D:/x/dao.md" },
  ]);
  const last = H.selfcheckLines(ruleEchoSc(stale)).lines.at(-1);
  check("正控：超 staleDays → 追加陈旧告警（两空格缩进）；负控：未超 → 不追加",
    /^ {2}⚠ 末次真实触发距今 40 天/.test(last) &&
    !H.selfcheckLines(ruleEchoSc(writeJsonl("fresh.jsonl", [
      { at: new Date(Date.now() - 3 * 86400000).toISOString(), tool: "Write", file: "D:/x/dao.md" },
    ]))).lines.some((l) => /⚠ 末次真实触发距今/.test(l)));
}
{
  const logPath = writeJsonl("with-garbage.jsonl", [
    "这不是 JSON{{{",
    { at: new Date(Date.now() - 1 * 86400000).toISOString(), tool: "Edit", file: "D:/x/a.md" },
    "又一行垃圾",
  ]);
  check("坏行被跳过、真实记录仍被认出（不误判为失联）",
    /^✓ 有真实触发记录/.test(H.selfcheckLines(ruleEchoSc(logPath)).lines.at(-1)));
}

console.log("\n=== 注册半段（假家目录注入，不依赖真实 live settings）===");
{
  // 假家目录里写一份 settings.json：注册了 dao-rule-echo.js ⇒ ✓；没注册 ⇒ ✗。
  // 断言确定性由夹具给，不再读跑测试这台机器的 ~/.claude/settings.json（#308）。
  const LIVE = path.join(FAKE_HOME, ".claude", "settings.json");
  const logPath = path.join(TMP, "empty-real.jsonl");
  fs.mkdirSync(path.dirname(LIVE), { recursive: true });
  fs.writeFileSync(LIVE, JSON.stringify({
    hooks: { PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "node ccswitch/hooks/dao-rule-echo.js" }] }] },
  }), "utf8");
  const reg = H.selfcheckLines(ruleEchoSc(logPath)).lines[0];
  check("已注册：输出 ✓ 形态、事件名与 matcher 正确",
    /^✓ 已注册于 PostToolUse，matcher="\*"/.test(reg), reg);
  fs.writeFileSync(LIVE, JSON.stringify({ permissions: { deny: [] } }), "utf8");
  const unreg = H.selfcheckLines(ruleEchoSc(logPath)).lines[0];
  check("未注册：输出 ✗ 形态且点名脚本名", /^✗ 未注册：/.test(unreg) && /dao-rule-echo\.js/.test(unreg), unreg);
  const sc = ruleEchoSc(logPath);
  sc.scriptName = "dao-no-such-hook-zzz.js";
  check("不存在的 scriptName → 判未注册（注册判据真在查这个名字）",
    /^✗ 未注册：/.test(H.selfcheckLines(sc).lines[0]));
}
{
  // appendJsonl 是主产物语义 ⇒ 必须抛；heartbeat 是旁证语义 ⇒ 必须吞（库头注「勿顺手统一」那一条）
  const blocker = path.join(TMP, "blocker");
  fs.writeFileSync(blocker, "i am a file", "utf8");
  let threw = false;
  try { lib.appendJsonl(path.join(blocker, "sub", "x.jsonl"), { a: 1 }); } catch (_) { threw = true; }
  const H2 = lib.createHookScaffold({
    name: "knifeF-probe2", stateSubdir: "knifeF-collide-state", failTail: "x",
    forceErrorEnv: "KNIFEF_P2_FORCE_ERROR", selfTestEnv: "KNIFEF_P2_SELFTEST",
  });
  fs.writeFileSync(path.join(REPO, "_tmp", "knifeF-collide-state"), "i am a file", "utf8");
  let threw2 = false;
  try { H2.heartbeat({ at: "now" }); } catch (_) { threw2 = true; }
  check("appendJsonl 写不成 → 抛；heartbeat 写不成 → 吞（不许拖垮主产物）",
    threw && !threw2);
  fs.rmSync(path.join(REPO, "_tmp", "knifeF-collide-state"), { force: true });
}

console.log("\n=== jsonl helpers + isSynthetic ===");
{
  check("parseJsonl 跳坏行留好行 / 空串空数组 / 文件不存在空数组",
    lib.parseJsonl('{"a":1}\n坏\n{"b":2}\n').length === 2 &&
    lib.parseJsonl("").length === 0 &&
    lib.readJsonlRecords(path.join(TMP, "nope.jsonl")).length === 0);
  const p = path.join(TMP, "rotate.jsonl");
  fs.writeFileSync(p, Array.from({ length: 12 }, (_, i) => JSON.stringify({ i })).join("\n") + "\n", "utf8");
  lib.rotateJsonl(p, 10);
  const after = lib.readJsonlRecords(p);
  check("rotateJsonl 超上限 → 裁到 max/2 条且保留后半（新记录不丢）",
    after.length === 5 && after[0].i === 7 && after.at(-1).i === 11, JSON.stringify(after.map((x) => x.i)));
  const H3 = lib.createHookScaffold({
    name: "knifeF-probe3", stateSubdir: "knifeF-hook-selfcheck-tests/state3", failTail: "x",
    forceErrorEnv: "KNIFEF_P3_FORCE_ERROR", selfTestEnv: "KNIFEF_P3_SELFTEST",
  });
  check("isSynthetic：缺 transcript_path → synthetic；带 → 非",
    H3.isSynthetic({ tool_name: "Edit" }) === true &&
    H3.isSynthetic({ transcript_path: "x" }) === false);
  process.env.KNIFEF_P3_SELFTEST = "1";
  check("自测环境变量置位 → 强制 synthetic（即便带 transcript_path）",
    H3.isSynthetic({ transcript_path: "x" }) === true);
  delete process.env.KNIFEF_P3_SELFTEST;
}

console.log("\n=== 留痕域可写性（opt-in）===");
{
  // 治的病：脚手架把 errors/fired/last 三样全放在同一 `_tmp/<subdir>/` 域里，而写它们的
  // 函数都吞异常 ⇒ 域坏掉时三样一起哑、退出码干净，「没记下来」与「没发生」逐字节相同。
  const LOG = path.join(TMP, "empty-real.jsonl");
  const base = H.selfcheckLines(ruleEchoSc(LOG));
  check("不传 probeDirs ⇒ 一行都不多（两个既有消费方输出一个字节没变）",
    base.lines.every((l) => !/留痕域/.test(l)));
  const scOk = ruleEchoSc(LOG);
  scOk.probeDirs = [{ label: "测试域", dir: path.join(TMP, "probe-good"), failNote: "（好域尾注不该出现）" }];
  const rOk = H.selfcheckLines(scOk);
  const okLine = rOk.lines.find((l) => /留痕域/.test(l));
  check("可写 ⇒ ✓ 行点名 label/路径、不增 bad、探针写完就删",
    /^✓ 留痕域可写：测试域 → /.test(okLine || "") && rOk.bad === base.bad &&
    fs.readdirSync(path.join(TMP, "probe-good")).length === 0, JSON.stringify(okLine));
  const blocker = path.join(TMP, "probe-blocker");
  fs.writeFileSync(blocker, "我是一个普通文件", "utf8");
  const scBad = ruleEchoSc(LOG);
  scBad.probeDirs = [{ label: "坏域", dir: path.join(blocker, "state"), failNote: "（坏域尾注ZZZ）" }];
  const badLine = H.selfcheckLines(scBad).lines.find((l) => /留痕域/.test(l));
  check("写不进 ⇒ ✗ 行带 errno + failNote + 明说污染第②段结论 + bad+1",
    /^✗ 留痕域写不进去：坏域 → /.test(badLine || "") && /ENOTDIR|EEXIST|ENOENT|EPERM|EACCES/.test(badLine || "") &&
    /（坏域尾注ZZZ）/.test(badLine || "") && /可能只是写不进去，不是没触发过/.test(badLine || "") &&
    H.selfcheckLines(scBad).bad === base.bad + 1, JSON.stringify(badLine));
  // 判据是「真写一次」不是「目录存在吗」：existsSync 对「父路径是文件」与「路径从未建过」
  // 给出同一个 false，这正是必须真写的原因。
  check("probeDirWritable：可写 ⇒ ok=true；父路径是文件 ⇒ ok=false 且给 why（existsSync 分不出这两者）",
    lib.probeDirWritable(path.join(TMP, "pw-ok")).ok === true &&
    (() => { const pw = lib.probeDirWritable(path.join(blocker, "x")); return pw.ok === false && typeof pw.why === "string"; })());
}

console.log("\n=== maybeForceError 相位（把异常精确投到内层 try 之外）===");
{
  const H4 = lib.createHookScaffold({
    name: "knifeF-probe4", stateSubdir: "knifeF-hook-selfcheck-tests/state4", failTail: "x",
    forceErrorEnv: "KNIFEF_P4_FORCE_ERROR", selfTestEnv: "KNIFEF_P4_SELFTEST",
  });
  const threw = (stage) => { try { H4.maybeForceError(stage); return false; } catch (_) { return true; } };
  const had = Object.prototype.hasOwnProperty.call(process.env, "KNIFEF_P4_FORCE_ERROR");
  try {
    delete process.env.KNIFEF_P4_FORCE_ERROR;
    check("未设 ⇒ 不抛；`=1` ⇒ 全抛；`=outer` ⇒ 只有 outer 抛；不存在的相位名 ⇒ 不抛",
      !threw("parse") &&
      (process.env.KNIFEF_P4_FORCE_ERROR = "1") && threw("parse") && threw("outer") &&
      (process.env.KNIFEF_P4_FORCE_ERROR = "outer") && !threw("parse") && threw("outer") &&
      (process.env.KNIFEF_P4_FORCE_ERROR = "no-such-phase") && !threw("parse") && !threw("outer"));
  } finally { delete process.env.KNIFEF_P4_FORCE_ERROR; }
  check("收尾：环境变量已复原（本节自己不许留污染）",
    Object.prototype.hasOwnProperty.call(process.env, "KNIFEF_P4_FORCE_ERROR") === had);
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
