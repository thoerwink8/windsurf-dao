// dao-compact-log 两态自证 · 单元级（喂 PostCompact 形态 JSON → 断言 stdout/日志）
//
// 跑法：node tests/dao-compact-log.tests.js   （全绿 exit 0，任一红 exit 1）
//
// 验的是哪一层：**hook 脚本自身的输入→输出契约**。它证明「命中即产出结构正确的
// systemMessage / 落盘一行日志 / 出错不静默」，**不证明** systemMessage 真的被
// 模型下一轮读到——那是 PostCompact 文档未逐字担保的能力，需真实 compaction 后
// 人工核对（见 dao-compact-log.js 头注③，本测试不为此打包票）。
//
// 用 spawnSync 直接喂 stdin，绕开 PowerShell 引号/编码坑。
// 全部用例带 DAO_COMPACT_LOG_SELFTEST=1，心跳标 synthetic，不污染 --selfcheck 的接线判定。
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOOK = path.resolve(__dirname, "..", "ccswitch", "hooks", "dao-compact-log.js");
const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const LOG_PATH = path.join(HOME, ".claude", "compaction-log.jsonl");

function run(payload, env) {
  const input = typeof payload === "string" ? payload : JSON.stringify(payload);
  const r = spawnSync(process.execPath, [HOOK], {
    input,
    encoding: "utf8",
    env: Object.assign({}, process.env, { DAO_COMPACT_LOG_SELFTEST: "1" }, env || {}),
  });
  let json = null;
  if (r.stdout && r.stdout.trim()) { try { json = JSON.parse(r.stdout); } catch (_) {} }
  return { code: r.status, out: r.stdout || "", err: r.stderr || "", json };
}

// 真实宿主 PostCompact 输入形态（字段沿用 PreCompact 已确认的通用字段 + trigger）
function pc(trigger, extra) {
  return Object.assign({
    session_id: "test-session-compact",
    transcript_path: "C:/fake/transcript.jsonl",
    cwd: "D:/frank/windsurf-dao",
    hook_event_name: "PostCompact",
    trigger,
  }, extra || {});
}

function lastLogLine() {
  if (!fs.existsSync(LOG_PATH)) return null;
  const lines = fs.readFileSync(LOG_PATH, "utf8").split(/\r?\n/).filter(Boolean);
  if (!lines.length) return null;
  try { return JSON.parse(lines[lines.length - 1]); } catch (_) { return null; }
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}
function sysMsg(r) {
  return (r.json && r.json.systemMessage) || "";
}

console.log("\n=== 正态：manual/auto 两种 trigger 都要产出 systemMessage + 落盘一行 ===");
{
  const before = fs.existsSync(LOG_PATH) ? fs.readFileSync(LOG_PATH, "utf8").split(/\r?\n/).filter(Boolean).length : 0;
  const r = run(pc("manual"));
  check("trigger=manual → 有 systemMessage", sysMsg(r).length > 0);
  check("trigger=manual → systemMessage 含 trigger 值", /trigger=manual/.test(sysMsg(r)), sysMsg(r));
  check("trigger=manual → exit 0", r.code === 0, "code=" + r.code);
  const after = fs.existsSync(LOG_PATH) ? fs.readFileSync(LOG_PATH, "utf8").split(/\r?\n/).filter(Boolean).length : 0;
  check("trigger=manual → 落盘增加一行", after === before + 1, `before=${before} after=${after}`);
  const last = lastLogLine();
  check("trigger=manual → 日志行 trigger 字段正确", !!last && last.trigger === "manual");
  check("trigger=manual → 日志行标 synthetic=true（自测不冒充真实触发）", !!last && last.synthetic === true);
  check("trigger=manual → 日志行含 session_id", !!last && last.session_id === "test-session-compact");
}
{
  const r = run(pc("auto"));
  check("trigger=auto → 有 systemMessage", sysMsg(r).length > 0);
  check("trigger=auto → systemMessage 含 trigger 值", /trigger=auto/.test(sysMsg(r)), sysMsg(r));
  const last = lastLogLine();
  check("trigger=auto → 日志行 trigger 字段正确", !!last && last.trigger === "auto");
}
{
  // PostCompact 文档未逐字给出 trigger 字段名——source 兜底，防字段名猜错致数据丢失
  const r = run({ session_id: "s2", transcript_path: "x", cwd: "y", hook_event_name: "PostCompact", source: "auto" });
  check("兜底字段 source（无 trigger）→ 仍捕获 trigger=auto", /trigger=auto/.test(sysMsg(r)), sysMsg(r));
}
{
  // 缺 trigger 与 source → unknown，不报错、不吞
  const r = run({ session_id: "s3", transcript_path: "x", cwd: "y", hook_event_name: "PostCompact" });
  check("缺 trigger/source → 降级为 unknown 而非崩溃", /trigger=unknown/.test(sysMsg(r)), sysMsg(r));
  check("缺 trigger/source → 仍 exit 0", r.code === 0, "code=" + r.code);
}
{
  // hookSpecificOutput.additionalContext 未被文档证实对 PostCompact 生效——本 hook
  // 不应产出该字段，避免打一个未验证的包票。
  const r = run(pc("manual"));
  check("不产出 hookSpecificOutput（未验证能力不硬编）", !(r.json && r.json.hookSpecificOutput));
}

console.log("\n=== 错误可见性：出错必须留痕，且不取阻断语义 ===");
{
  const r = run("这不是 JSON{{{");
  check("坏 stdin → stderr 有痕", /\[dao-compact-log\].*失败/.test(r.err), "err=" + JSON.stringify(r.err));
  check("坏 stdin → systemMessage 用户可见", !!(r.json && r.json.systemMessage), "out=" + r.out.slice(0, 200));
  check("坏 stdin → 不阻断（exit 0）", r.code === 0, "code=" + r.code);
}
{
  const r = run(pc("manual"), { DAO_COMPACT_LOG_FORCE_ERROR: "1" });
  check("内部故障闸 → stderr 有痕", /\[dao-compact-log\].*失败/.test(r.err), "err=" + JSON.stringify(r.err));
  check("内部故障闸 → systemMessage 用户可见", !!(r.json && r.json.systemMessage));
  check("内部故障闸 → exit 0 不阻断", r.code === 0, "code=" + r.code);
  check("内部故障闸 → 未静默（stdout+stderr 至少一处有内容）", r.out !== "" || r.err !== "");
}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
