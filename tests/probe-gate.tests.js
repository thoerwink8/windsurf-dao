// dao-probe-gate 两态自证 · 端到端 + 单元（每个行为分支留正控 + 负控 + 先破再验 mutation）
//
// 跑法：node tests/probe-gate.tests.js   （全绿 exit 0，任一红 exit 1）
//
// 验的层：探针 × 无标记 → block；探针 × 有标记 → 放行 + 注入标记全文；非探针 prompt → 零输出
// 零磁盘（含镜像域）；fail-open 三条失败路径全倒向放行；标记陈旧判据（分类不改判定）；
// 宿主失效态两格；mutation 判据四向（放松/关闭/结果不被消费/文档形态）。
// 标记由**哨兵真跑一次**产生（不是手捏 JSON）——两个 hook 的字段契约才真的被夹住。
// mutation 锚点单行、断言与 replace 同一个字符串对象；每个 mutant 配 canary。

const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const REAL_HOOK = path.join(REPO, "ccswitch", "hooks", "dao-probe-gate.js");
const REAL_SENTINEL = path.join(REPO, "ccswitch", "hooks", "dao-rate-limit-sentinel.js");
const TAG = "probegate-" + process.pid + "-" + Math.random().toString(36).slice(2, 8);
const BASE = path.join(REPO, "_tmp", TAG);

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  ->  " + detail : ""}`); }
}
fs.mkdirSync(BASE, { recursive: true });

function rootOf(hookPath) { return path.resolve(path.dirname(hookPath), "..", ".."); }
function markerPath(tag) { return path.join(BASE, tag, "rate-limit-interrupt.json"); }
function firedPath(tag, hookPath) { return path.join(rootOf(hookPath || REAL_HOOK), "_tmp", TAG, tag, "state", "fired.log"); }
function errorsPath(tag, hookPath) { return path.join(rootOf(hookPath || REAL_HOOK), "_tmp", TAG, tag, "state", "errors.log"); }
// issue #232：镜像留痕域——envFor 只传 MARKER/STATE_SUBDIR、不传 MIRROR ⇒ 命中
// deriveMirrorFallback() 第一分支（与 hook 源码同一套算法）。
function mirrorErrorsPath(tag) { return path.join(path.dirname(markerPath(tag)), "probe-gate-mirror-fallback", "errors.log"); }
function envFor(tag) {
  return Object.assign({}, process.env, {
    DAO_RATE_LIMIT_MARKER: markerPath(tag),
    DAO_PROBE_GATE_STATE_SUBDIR: path.posix.join(TAG, tag, "state"),
  });
}
function armMarker(tag, over) {
  fs.mkdirSync(path.dirname(markerPath(tag)), { recursive: true });
  const payload = JSON.stringify(Object.assign({
    session_id: "sid-" + TAG,
    transcript_path: "C:/fake/transcript.jsonl",
    cwd: REPO,
    hook_event_name: "StopFailure",
    error: "rate_limit",
    error_details: "429 Too Many Requests",
    last_assistant_message: "API Error: Rate limit reached · 约 2 小时 30 分钟后重置",
  }, over || {}));
  const env = Object.assign({}, process.env, {
    DAO_RATE_LIMIT_MARKER: markerPath(tag),
    DAO_RATE_LIMIT_STATE_SUBDIR: path.posix.join(TAG, tag, "sentinel-state"),
    DAO_RATE_LIMIT_MIRROR: path.join(BASE, tag, "sentinel-mirror", "fired.log"),
  });
  spawnSync(process.execPath, [REAL_SENTINEL], { input: payload, encoding: "utf8", env });
  return markerPath(tag);
}
function run(hookPath, prompt, tag, rawInput) {
  const input = rawInput != null ? rawInput : JSON.stringify({
    session_id: "sid-" + TAG, transcript_path: "C:/fake/transcript.jsonl", cwd: REPO,
    hook_event_name: "UserPromptSubmit", prompt,
  });
  const r = spawnSync(process.execPath, [hookPath], { input, encoding: "utf8", env: envFor(tag) });
  let json = null;
  if (r.stdout && r.stdout.trim()) { try { json = JSON.parse(r.stdout); } catch (_) {} }
  return { code: r.status, out: r.stdout || "", err: r.stderr || "", json };
}
function ctx(r) { return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || ""; }
function blocked(r) { return !!(r.json && r.json.decision === "block"); }
function firedLines(tag, hookPath) {
  try {
    return fs.readFileSync(firedPath(tag, hookPath), "utf8").split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}

const SRC = fs.readFileSync(REAL_HOOK, "utf8");
const SHA_BEFORE = crypto.createHash("sha256").update(SRC).digest("hex");
function relRequiresOf(src) {
  return [...src.matchAll(/require\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)].map((m) => m[1]);
}
function mutantHook(tag, anchor, replacement) {
  check(`mutation 靶点在源码里唯一存在（${tag}）`, SRC.split(anchor).length === 2, `出现 ${SRC.split(anchor).length - 1} 次`);
  const root = path.join(BASE, "mut-" + tag);
  const hooksDir = path.join(root, "ccswitch", "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  const deps = relRequiresOf(SRC);
  check(`沙箱前提：${tag} 的相对依赖能逐个定位`, deps.length > 0 && deps.every((d) => fs.existsSync(path.resolve(path.dirname(REAL_HOOK), d))));
  for (const d of deps) {
    const from = path.resolve(path.dirname(REAL_HOOK), d);
    const to = path.resolve(hooksDir, d);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  fs.writeFileSync(path.join(hooksDir, "dao-probe-gate.js"), SRC.replace(anchor, replacement), "utf8");
  return path.join(hooksDir, "dao-probe-gate.js");
}

console.log("\n=== 正态 · 探针 × 无标记 → block ===");
{
  const r = run(REAL_HOOK, "[dao-probe] 查中断：有没有被限流打断的活？", "block");
  check("exit 0 + decision=block + reason 带签名（block 走 JSON 通道，不走 exit 2）",
    r.code === 0 && blocked(r) && /\[dao-probe-gate v1\]/.test(r.json.reason || ""));
  // suppressOriginalPrompt 在 hookSpecificOutput 里（不在顶层——官方文档那张表会把人带偏，zod strip 静默吞）
  check("suppressOriginalPrompt 在 hookSpecificOutput 里（顶层没有），hookEventName 正确",
    r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.suppressOriginalPrompt === true &&
    r.json.suppressOriginalPrompt === undefined &&
    r.json.hookSpecificOutput.hookEventName === "UserPromptSubmit");
  check("fired.log 记 decision=block / marker_state=none（验收判据③靠它确认 block 真发生过）",
    firedLines("block").length === 1 && firedLines("block")[0].decision === "block" && firedLines("block")[0].marker_state === "none");
}

console.log("\n=== 正态 · 探针 × 有标记 → 放行 + 注入标记全文 ===");
{
  const tag = "allow";
  armMarker(tag);
  const r = run(REAL_HOOK, "[dao-probe] 查中断", tag);
  const c = ctx(r);
  check("不 block + 注入带签名、标记承重字段（at/error/reset_estimate_s）、标记路径、提醒接手前先删",
    !blocked(r) && /\[dao-probe-gate v1\]/.test(c) && /"error": "rate_limit"/.test(c) &&
    /"reset_estimate_s": 9000/.test(c) && c.includes(markerPath(tag)) && /接手前先删/.test(c));
  check("hook 自己不删标记（删归探针轮）且 fired.log 记 decision=allow / marker_state=ok",
    fs.existsSync(markerPath(tag)) && firedLines(tag).length === 1 &&
    firedLines(tag)[0].decision === "allow" && firedLines(tag)[0].marker_state === "ok");
}

console.log("\n=== 负态 · 非探针 prompt：零输出、零磁盘（含镜像域）===");
{
  for (const [name, prompt] of [
    ["普通中文消息", "帮我看看这个函数的实现"],
    ["心跳签名（同仓另一个签名，绝不能串味）", "[dao-heartbeat] 高性能目标窗心跳。对账：① 三路在途"],
    ["大小写/连字符/不闭合变体", "[DAO-PROBE] 查中断"],
    ["签名不在开头", "顺带说一句 [dao-probe] 查中断"],
    ["空 prompt", ""],
  ]) {
    const tag = "neg-" + name.slice(0, 6).replace(/[^\u4e00-\u9fff\w]/g, "");
    const r = run(REAL_HOOK, prompt, tag);
    // issue #247 H3：扫描面含镜像域——非探针路径若偷写镜像域，旧负控一条都不红
    check(`负控：${name} → stdout 零字节 + exit 0 + 零磁盘（含镜像域）`,
      r.out === "" && r.code === 0 && firedLines(tag).length === 0 &&
      !fs.existsSync(errorsPath(tag)) && !fs.existsSync(mirrorErrorsPath(tag)));
  }
  {
    // 先破再验：非探针路径偷写镜像域 ⇒ 上面新增的镜像域检查必须翻面（归因：#247 H3 原始实测 0 红）
    const ANCHOR = "    // 这条路径覆盖**每一条用户消息**，所以它必须什么都不做。往这里加任何一次写盘，";
    const h = mutantHook("h3-mirror-leak", ANCHOR, ANCHOR + '\n    mirrorErrorLog("issue #247 H3 mutation：非探针路径偷写镜像域");');
    const r = run(h, "帮我看看这个函数的实现", "h3-neg-mut");
    check("先破再验：非探针偷写镜像域 ⇒ 镜像域检查翻面；canary：exit 0、stdout 零字节、主域仍零",
      fs.existsSync(mirrorErrorsPath("h3-neg-mut")) && r.code === 0 && r.out === "" &&
      !fs.existsSync(errorsPath("h3-neg-mut")));
  }
  check("正控（配对项）：前导空白仍认（判据是 trim 后的前缀）", blocked(run(REAL_HOOK, "  \n[dao-probe] 查中断", "leadws")));
  check("正控：签名后无空格紧跟内容 / 只有签名本身 → 仍认",
    blocked(run(REAL_HOOK, "[dao-probe]查中断", "tight")) && blocked(run(REAL_HOOK, "[dao-probe]", "tight2")));
}

console.log("\n=== fail-open · 失败路径全倒向放行 ===");
{
  const tag = "badmarker";
  fs.mkdirSync(path.dirname(markerPath(tag)), { recursive: true });
  fs.writeFileSync(markerPath(tag), "{这不是合法 JSON", "utf8");
  const r = run(REAL_HOOK, "[dao-probe] 查中断", tag);
  check("坏标记 JSON → 不 block，注入说明「不构成刚被限流的证据」，写主域+镜像 errors.log",
    !blocked(r) && /不构成/.test(ctx(r)) && fs.existsSync(errorsPath(tag)) && fs.existsSync(mirrorErrorsPath(tag)));
  check("坏标记 → fired.log 记 marker_state=bad（与 none/ok 三态分得开）",
    firedLines(tag)[0] && firedLines(tag)[0].marker_state === "bad");
  const tag2 = "marker-is-dir";
  fs.mkdirSync(markerPath(tag2), { recursive: true });
  const r2 = run(REAL_HOOK, "[dao-probe] 查中断", tag2);
  check("标记路径是目录（读不动而非不存在）→ 放行，走 bad 不是误判成 none 而 block",
    !blocked(r2) && firedLines(tag2)[0] && firedLines(tag2)[0].marker_state === "bad");
}

console.log("\n=== 标记陈旧判据（分类不改判定）===");
{
  const { markerStaleness, STALE_GRACE_S } = require(REAL_HOOK);
  const NOW = Date.UTC(2026, 7, 8, 6, 0, 0);
  const at = (offsetS) => new Date(NOW + offsetS * 1000).toISOString();
  check("余量是正数（0/负数会让每份标记都被判陈旧——比没有这个判据更糟）",
    Number.isFinite(STALE_GRACE_S) && STALE_GRACE_S > 0);
  check("单元：超界→陈旧 / 恰在界上不陈旧 / 界外 1 秒陈旧 / reset null 按 0 计 / at 读不出→不判陈旧且给理由",
    markerStaleness({ at: at(-(3600 + STALE_GRACE_S + 60)), reset_estimate_s: 3600 }, NOW).stale === true &&
    markerStaleness({ at: at(-(3600 + STALE_GRACE_S)), reset_estimate_s: 3600 }, NOW).stale === false &&
    markerStaleness({ at: at(-(STALE_GRACE_S + 10)), reset_estimate_s: null }, NOW).stale === true &&
    markerStaleness({ at: "不是时间" }, NOW).stale === false && typeof markerStaleness({ at: "不是时间" }, NOW).why === "string");

  const tag = "stale";
  armMarker(tag);
  const fresh = run(REAL_HOOK, "[dao-probe] 查中断", tag);
  check("端到端·负控：刚写下的标记 → 放行且不提陈旧，fired.log 记 marker_stale=false",
    !blocked(fresh) && !/已经陈旧/.test(ctx(fresh)) && firedLines(tag)[0].marker_stale === false);
  const tag2 = "stale-old";
  armMarker(tag2);
  { const doc = JSON.parse(fs.readFileSync(markerPath(tag2), "utf8"));
    doc.at = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
    fs.writeFileSync(markerPath(tag2), JSON.stringify(doc, null, 2), "utf8"); }
  const old = run(REAL_HOOK, "[dao-probe] 查中断", tag2);
  check("🔴 端到端：陈旧标记**仍然放行**（陈旧只改分类不改判定），注入明说陈旧+仍然放行，fired.log 带 overdue",
    !blocked(old) && /已经陈旧/.test(ctx(old)) && /仍然放行/.test(ctx(old)) &&
    firedLines(tag2)[0].marker_stale === true && firedLines(tag2)[0].marker_overdue_s > 0);
  {
    const ANCHOR = "  const stale = marker.state === \"ok\" ? markerStaleness(marker.doc, nowMs) : null;";
    const h = mutantHook("stale-null", ANCHOR, "  const stale = null;");
    const t = "stale-mut-null";
    armMarker(t);
    { const doc = JSON.parse(fs.readFileSync(markerPath(t), "utf8"));
      doc.at = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
      fs.writeFileSync(markerPath(t), JSON.stringify(doc, null, 2), "utf8"); }
    const r = run(h, "[dao-probe] 查中断", t);
    check("先破再验①（放宽向）：陈旧判定恒 null ⇒ 陈旧那两条断言翻面；canary：照常放行注入全文",
      !/已经陈旧/.test(ctx(r)) && firedLines(t, h)[0].marker_stale === null && !blocked(r) && /"error": "rate_limit"/.test(ctx(r)));
  }
  {
    const ANCHOR = "  return { stale: overdue > 0, overdue_s: overdue, why: null };";
    const h = mutantHook("stale-true", ANCHOR, "  return { stale: true, overdue_s: overdue, why: null };");
    const t = "stale-mut-true";
    armMarker(t);
    const r = run(h, "[dao-probe] 查中断", t);
    check("先破再验②（收紧向）：陈旧判定恒真 ⇒ 刚写的标记也被标陈旧；canary：仍然放行",
      /已经陈旧/.test(ctx(r)) && firedLines(t, h)[0].marker_stale === true && !blocked(r));
  }
}

console.log("\n=== 宿主失效态两格 ===");
{
  // 模块加载期崩：require 就失败 ⇒ 连 main() 都没进。判据是「不是 2」（2 才 block=吞用户消息）。
  const crashDir = path.join(BASE, "loadcrash", "ccswitch", "hooks");
  fs.mkdirSync(crashDir, { recursive: true });
  fs.copyFileSync(REAL_HOOK, path.join(crashDir, "dao-probe-gate.js")); // 刻意不拷 lib
  const rc = spawnSync(process.execPath, [path.join(crashDir, "dao-probe-gate.js")], {
    input: JSON.stringify({ prompt: "帮我看看这个函数的实现", session_id: "s", transcript_path: "C:/f/t.jsonl", cwd: REPO }),
    encoding: "utf8", env: envFor("loadcrash"),
  });
  check("模块加载期崩 → 退出码非 0 且**不是 2**，stdout 零输出，stderr 是 MODULE_NOT_FOUND",
    rc.status !== 0 && rc.status !== 2 && (rc.stdout || "") === "" && /Cannot find module|MODULE_NOT_FOUND/.test(rc.stderr || ""));
  // stdout 写不动（EPIPE 形态）：node -r 桩把 write 换成必抛 ⇒ 仍 exit 0，账照记
  const stub = path.join(BASE, "epipe-stub.js");
  fs.writeFileSync(stub, 'process.stdout.write = function () { const e = new Error("write EPIPE"); e.code = "EPIPE"; throw e; };\n', "utf8");
  const re = spawnSync(process.execPath, ["-r", stub, REAL_HOOK], {
    input: JSON.stringify({ prompt: "[dao-probe] 查中断", session_id: "sid-" + TAG, transcript_path: "C:/fake/t.jsonl", cwd: REPO }),
    encoding: "utf8", env: envFor("epipe"),
  });
  check("stdout 写不动 → 仍 exit 0、宿主收不到 block（fail-open 方向对）、fired.log 仍记 decision=block（账要留下）",
    re.status === 0 && !/"decision"\s*:\s*"block"/.test(re.stdout || "") &&
    firedLines("epipe")[0] && firedLines("epipe")[0].decision === "block");
}

console.log("\n=== mutation · 判据四向 ===");
{
  {
    const ANCHOR = "const PROBE_SIG = /^\\[dao-probe\\]/;";
    const h = mutantHook("loosen", ANCHOR, "const PROBE_SIG = /^/;");
    const before = run(REAL_HOOK, "帮我看看这个函数的实现", "mutL-a");
    const after = run(h, "帮我看看这个函数的实现", "mutL-b");
    check("放松向：判据改恒真 ⇒ 普通消息被 block（负控组有判别力）；canary：真探针仍照常 block",
      before.out === "" && blocked(after) && blocked(run(h, "[dao-probe] 查中断", "mutL-canary")));
  }
  {
    const ANCHOR = "  if (!PROBE_SIG.test(prompt.trim())) {";
    const h = mutantHook("disable", ANCHOR, "  if (true || !PROBE_SIG.test(prompt.trim())) {");
    const before = run(REAL_HOOK, "[dao-probe] 查中断", "mutD-a");
    const after = run(h, "[dao-probe] 查中断", "mutD-b");
    check("关闭向：早退恒成立 ⇒ 探针零输出（正控组有判别力）；canary：exit 0 不是崩",
      blocked(before) && after.out === "" && after.code === 0);
  }
  {
    const ANCHOR = 'const decision = marker.state === "none" ? "block" : "allow";';
    const h = mutantHook("unconsumed", ANCHOR, 'readMarker; const decision = "allow";');
    const after = run(h, "[dao-probe] 查中断", "mutU-a");
    check("结果不被消费向：判定恒 allow ⇒ 不再 block，但副作用仍在（fired.log 照记 marker_state=none）",
      !blocked(after) && firedLines("mutU-a", h).length === 1 && firedLines("mutU-a", h)[0].marker_state === "none");
  }
  {
    const ANCHOR = "    hookSpecificOutput: { hookEventName: EVENT, suppressOriginalPrompt: true },";
    const h = mutantHook("suppress-toplevel", ANCHOR, "    suppressOriginalPrompt: true,\n    hookSpecificOutput: { hookEventName: EVENT },");
    const after = run(h, "[dao-probe] 查中断", "mutS-a");
    check("文档形态向：suppressOriginalPrompt 挪到顶层 ⇒ 位置断言翻面（行为断言全绿，只有位置断言逮得住）",
      blocked(after) && after.json.suppressOriginalPrompt === true && after.json.hookSpecificOutput.suppressOriginalPrompt === undefined);
  }
  check("canary 恒等：真 hook 文件全程未被改动",
    crypto.createHash("sha256").update(fs.readFileSync(REAL_HOOK)).digest("hex") === SHA_BEFORE);
}

console.log("\n=== 跨文件一致性：闸门读的路径 = 哨兵写的路径 ===");
{
  const tag = "e2e";
  const before = run(REAL_HOOK, "[dao-probe] 查中断", tag);
  check("哨兵没跑过 ⇒ block", blocked(before));
  armMarker(tag);
  const after = run(REAL_HOOK, "[dao-probe] 查中断", tag);
  check("哨兵真跑一次 ⇒ 同一闸门当场改判放行（两 hook 认同一个路径与同一套字段）",
    !blocked(after) && /"error": "rate_limit"/.test(ctx(after)));
  fs.rmSync(markerPath(tag), { force: true });
  check("标记被删（模拟探针接手后清理）⇒ 下一轮回到 block", blocked(run(REAL_HOOK, "[dao-probe] 查中断", tag)));
}

try { fs.rmSync(BASE, { recursive: true, force: true }); } catch (_) {}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
