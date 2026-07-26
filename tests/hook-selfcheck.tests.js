// hook-selfcheck 公共库自证 · 单元级（直接 require 库，断言脚手架各件的契约）
//
// 跑法：node tests/hook-selfcheck.tests.js   （全绿 exit 0，任一红 exit 1）
//
// ── 为什么单独给库补测（而不是靠两个 hook 的测试兜住）───────────────────────
// F1 把加固脚手架抽成本库时，`selfcheckLines` 变成一个**11 参的文案模板**。
// 而 dao-rule-echo / dao-compact-log 两套既有测试**完全不覆盖 --selfcheck 路径**
// ——它们喂 stdin 验主流程，不跑自检。这意味着模板文案改坏了没有任何东西会变红。
//
// 这不是假想风险：F1 重构当时就真踩了一次。库里把
//   `因 ${sc.missNote}不匹配`  写成了  `因 ${sc.missNote} 不匹配`（多一个空格）
// 两套 hook 测试全绿、毫无察觉，是靠人工把 --selfcheck 输出与重构前逐字节 diff
// 才捞出来的。人工 diff 只发生一次，模板却会被反复编辑 ⇒ 必须留下常驻断言。
//
// 覆盖面与有意不覆盖：
//   · 心跳半段（本次出 bug 的那半段）**逐字锚定**：logPath 可由参数注入 ⇒ 完全确定性。
//   · 注册半段读真实 live settings.json（LIVE_SETTINGS 是模块常量，不可注入）
//     ⇒ 只断言两种形态之一与格式骨架，不锚定具体是「已注册」还是「未注册」。
//     这是如实的能力边界，不是偷工：把它硬锚会让测试随用户配置变化而红。
//   · 「日志写失败语义有意不同」这条设计约定（heartbeat 吞 / appendJsonl 抛）
//     也上断言 —— 它是库头注写明「勿顺手统一」的那一条，值得机器盯着。

const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const lib = require("../ccswitch/lib/hook-selfcheck.js");
const TMP = path.join(REPO, "_tmp", "knifeF-hook-selfcheck-tests");

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

console.log("\n=== 心跳半段 · 无真实记录（逐字锚定，钉住 F1 踩过的空白 bug）===");
{
  const logPath = writeJsonl("empty-real.jsonl", [
    { at: "2026-07-26T00:00:00.000Z", synthetic: true },
    { at: "2026-07-26T00:00:01.000Z", synthetic: true },
  ]);
  const r = H.selfcheckLines(ruleEchoSc(logPath));
  const hb = r.lines[r.lines.length - 1];
  const expected =
    "✗ 无真实触发记录（日志共 2 条，其中自测/手工 2 条）—— " +
    "尚未被宿主真实调用过；注册了也可能因 matcher/路径判据不匹配而从未触发。日志：" + logPath;
  check("无真实记录行逐字符与预期一致（含「判据不匹配」处无多余空白）", hb === expected,
    "\n    实得: " + JSON.stringify(hb) + "\n    预期: " + JSON.stringify(expected));
  check("「因 X不匹配」之间没有空格（F1 回归点）", /判据不匹配/.test(hb) && !/判据 不匹配/.test(hb), hb);
  check("无真实记录 → bad 计数 ≥1（不许当通过）", r.bad >= 1, "bad=" + r.bad);
  check("自测心跳不被采信为「已生效」", /尚未被宿主真实调用过/.test(hb));
}
{
  // 全空日志（文件不存在）也要给出 0/0 而不是崩
  const r = H.selfcheckLines(ruleEchoSc(path.join(TMP, "does-not-exist.jsonl")));
  const hb = r.lines[r.lines.length - 1];
  check("日志文件不存在 → 报「共 0 条，其中自测/手工 0 条」而非崩",
    /日志共 0 条，其中自测\/手工 0 条/.test(hb), hb);
}

console.log("\n=== 心跳半段 · 有真实记录（describeLast 插值 + 计数）===");
{
  const logPath = writeJsonl("has-real.jsonl", [
    { at: "2026-07-26T00:00:00.000Z", synthetic: true },
    { at: new Date(Date.now() - 2 * 86400000).toISOString(), tool: "Edit", file: "D:/x/CLAUDE.md" },
  ]);
  const r = H.selfcheckLines(ruleEchoSc(logPath));
  const hb = r.lines[r.lines.length - 1];
  check("有真实记录 → ✓ 开头", /^✓ 有真实触发记录/.test(hb), hb);
  check("describeLast 被正确插值（tool · file）", /Edit · D:\/x\/CLAUDE\.md/.test(hb), hb);
  check("真实/总数分别计数正确（真实 1 条 / 共 2 条）", /真实 1 条 \/ 共 2 条/.test(hb), hb);
  check("陈旧天数带一位小数", /（2\.0 天前）/.test(hb), hb);
  check("有真实记录 → 心跳半段不计 bad",
    r.bad === (/(^|\n)✗/.test(r.lines[0]) ? 1 : 0), "bad=" + r.bad + " line0=" + r.lines[0]);
}
{
  // 陈旧告警：超 staleDays 才追加，且带两空格缩进前缀
  const logPath = writeJsonl("stale.jsonl", [
    { at: new Date(Date.now() - 40 * 86400000).toISOString(), tool: "Write", file: "D:/x/dao.md" },
  ]);
  const r = H.selfcheckLines(ruleEchoSc(logPath));
  const last = r.lines[r.lines.length - 1];
  check("超 staleDays（40>30）→ 追加陈旧告警行", /⚠ 末次真实触发距今 40 天/.test(last), last);
  check("陈旧告警行带两空格缩进", /^ {2}⚠/.test(last), JSON.stringify(last));
}
{
  const logPath = writeJsonl("fresh.jsonl", [
    { at: new Date(Date.now() - 3 * 86400000).toISOString(), tool: "Write", file: "D:/x/dao.md" },
  ]);
  const r = H.selfcheckLines(ruleEchoSc(logPath));
  check("负控：未超 staleDays（3<30）→ 不追加陈旧告警",
    !r.lines.some((l) => /⚠ 末次真实触发距今/.test(l)), JSON.stringify(r.lines));
}

console.log("\n=== 心跳半段 · 坏行容错（日志坏一行不许被读成「从未触发」）===");
{
  const logPath = writeJsonl("with-garbage.jsonl", [
    "这不是 JSON{{{",
    { at: new Date(Date.now() - 1 * 86400000).toISOString(), tool: "Edit", file: "D:/x/a.md" },
    "又一行垃圾",
  ]);
  const r = H.selfcheckLines(ruleEchoSc(logPath));
  const hb = r.lines[r.lines.length - 1];
  check("坏行被跳过、真实记录仍被认出（不误判为失联）",
    /^✓ 有真实触发记录/.test(hb) && /真实 1 条 \/ 共 1 条/.test(hb), hb);
}

console.log("\n=== 注册半段 · 只断言形态骨架（LIVE_SETTINGS 不可注入，如实不锚定内容）===");
{
  const r = H.selfcheckLines(ruleEchoSc(path.join(TMP, "empty-real.jsonl")));
  const reg = r.lines[0];
  const shapeOk =
    /^✗ 未注册：.*的 hooks\.PostToolUse 里没有引用 dao-rule-echo\.js 的 command。$/.test(reg) ||
    /^[✓✗] 已注册于 PostToolUse，matcher=".*"/.test(reg);
  check("注册半段输出为两种既定形态之一", shapeOk, JSON.stringify(reg));
  check("注册半段提到正确的事件名与脚本名", /PostToolUse/.test(reg) && /dao-rule-echo\.js|已注册/.test(reg), reg);
}
{
  // scriptName 里的 `.` 必须被转义再当正则用，否则 `dao-rule-echoXjs` 也会命中
  const sc = ruleEchoSc(path.join(TMP, "empty-real.jsonl"));
  sc.scriptName = "dao-no-such-hook-zzz.js";
  const r = H.selfcheckLines(sc);
  check("不存在的 scriptName → 判为未注册（证明注册判据真在查这个名字）",
    /^✗ 未注册：/.test(r.lines[0]), JSON.stringify(r.lines[0]));
}

console.log("\n=== 有意保留的差异 · 日志写失败语义（库头注「勿顺手统一」那一条）===");
{
  // appendJsonl 是主产物语义 ⇒ 必须向上抛。造一个「父目录是文件」的路径让它必失败。
  const blocker = path.join(TMP, "blocker");
  fs.writeFileSync(blocker, "i am a file", "utf8");
  let threw = false;
  try { lib.appendJsonl(path.join(blocker, "sub", "x.jsonl"), { a: 1 }); } catch (_) { threw = true; }
  check("appendJsonl 写不成 → 向上抛（compact-log 靠它把失败报出来）", threw);
}
{
  // heartbeat 是旁证语义 ⇒ 必须吞掉。让 stateDir 撞上一个同名文件。
  const collide = path.join(REPO, "_tmp", "knifeF-collide-state");
  fs.rmSync(collide, { recursive: true, force: true });
  fs.writeFileSync(collide, "i am a file", "utf8");
  const H2 = lib.createHookScaffold({
    name: "knifeF-probe2",
    stateSubdir: "knifeF-collide-state",
    failTail: "x",
    forceErrorEnv: "KNIFEF_P2_FORCE_ERROR",
    selfTestEnv: "KNIFEF_P2_SELFTEST",
  });
  let threw2 = false;
  try { H2.heartbeat({ at: "now" }); } catch (_) { threw2 = true; }
  check("heartbeat 写不成 → 吞掉不抛（不许拖垮主产物）", !threw2);
  fs.rmSync(collide, { recursive: true, force: true });
}

console.log("\n=== jsonl helpers ===");
{
  check("parseJsonl 跳坏行留好行",
    lib.parseJsonl('{"a":1}\n坏\n{"b":2}\n').length === 2);
  check("parseJsonl 空串 → 空数组", lib.parseJsonl("").length === 0);
  check("readJsonlRecords 文件不存在 → 空数组",
    lib.readJsonlRecords(path.join(TMP, "nope.jsonl")).length === 0);
}
{
  // 轮转：超上限保留后半
  const p = path.join(TMP, "rotate.jsonl");
  const recs = [];
  for (let i = 0; i < 12; i++) recs.push({ i });
  fs.writeFileSync(p, recs.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  lib.rotateJsonl(p, 10);
  const after = lib.readJsonlRecords(p);
  check("rotateJsonl 超上限 → 裁到 max/2 条", after.length === 5, "len=" + after.length);
  check("rotateJsonl 保留的是**后**半（新记录不丢）",
    after[after.length - 1].i === 11 && after[0].i === 7, JSON.stringify(after.map((x) => x.i)));
}
{
  const p = path.join(TMP, "norotate.jsonl");
  fs.writeFileSync(p, '{"i":1}\n{"i":2}\n', "utf8");
  lib.rotateJsonl(p, 10);
  check("负控：未超上限 → 不动", lib.readJsonlRecords(p).length === 2);
}

console.log("\n=== isSynthetic 判据（近似，两向都有反例——见库头注）===");
{
  const H3 = lib.createHookScaffold({
    name: "knifeF-probe3", stateSubdir: "knifeF-hook-selfcheck-tests/state3",
    failTail: "x", forceErrorEnv: "KNIFEF_P3_FORCE_ERROR", selfTestEnv: "KNIFEF_P3_SELFTEST",
  });
  check("缺 transcript_path → synthetic", H3.isSynthetic({ tool_name: "Edit" }) === true);
  check("带 transcript_path → 非 synthetic", H3.isSynthetic({ transcript_path: "x" }) === false);
  process.env.KNIFEF_P3_SELFTEST = "1";
  check("自测环境变量置位 → 强制 synthetic（即便带 transcript_path）",
    H3.isSynthetic({ transcript_path: "x" }) === true);
  delete process.env.KNIFEF_P3_SELFTEST;
}

// ── 清理 ────────────────────────────────────────────────────────────────────
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
