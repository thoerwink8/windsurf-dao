// dao-rate-limit-sentinel 两态自证 · 端到端（喂 StopFailure 形态 JSON → 断言落盘）+ 解析式单元
//
// 跑法：node tests/rate-limit-sentinel.tests.js   （全绿 exit 0，任一红 exit 1）
//
// 验的是哪一层：**「哪些 error 写标记」这条判据 + 两式重置时间解析 + fail-open 三条路径**。
// 它证明「限流类 error 写标记 / 非限流类只记日志 / 坏输入不炸且留痕 / 幂等」，
// **不证明** StopFailure 在真限流时一定被宿主调用 —— 那要等一次真限流，
// 判据是 `node ccswitch/hooks/dao-rate-limit-sentinel.js --selfcheck` 的第②段（真实心跳）。
//
// ── 为什么不需要沙箱副本（与 dao-rhythm.tests.js 的做法不同，理由照直写）───────
// 被测 hook 的两处落盘面都有 env 覆写口：
//   · `DAO_RATE_LIMIT_MARKER`      —— 中断标记文件（**生产那份一旦被测试写出来，
//     下一轮真探针就会被放行去接手一件根本没发生的限流**，故这一条必须覆写）
//   · `DAO_RATE_LIMIT_STATE_SUBDIR` —— fired.log / errors.log 的子目录名
//     （生产那份 fired.log 是 #184 遗留观测格「真实限流实战样本」的耐久数据，
//       掺进合成样本等于污染将来那次复盘的结论）
// ⇒ 端到端那半直接跑**真文件**（测的就是它本身，不是一份可能过期的副本）。
// **只有 mutation 那半需要沙箱**：那半要改源码，绝不能改到真文件上。
//
// ── mutation 锚点纪律（[#守-锚点行尾]）──────────────────────────────────────
// 三个锚点**全是单行**（锚点里没有换行 ⇒ CRLF/LF 差异结构上咬不到它们）；
// 每个锚点**定义一次**，「锚点仍在」的断言与喂给 `replace()` 的是**同一个字符串对象**，
// 不是它的前缀或近似 —— 断言前缀而 mutation 用别的表达式，会在锚落空时照常 PASS。
// 每个 mutant 另配 canary（确认变异体还活着，不是整个 hook 崩了）。

const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const REAL_HOOK = path.join(REPO, "ccswitch", "hooks", "dao-rate-limit-sentinel.js");
const TAG = "rlsentinel-" + process.pid + "-" + Math.random().toString(36).slice(2, 8);
const BASE = path.join(REPO, "_tmp", TAG);

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  ->  " + detail : ""}`); }
}

fs.mkdirSync(BASE, { recursive: true });

// ── 端到端跑真文件，落盘面全部指进本次沙箱 ──────────────────────────────────
function envFor(tag) {
  return Object.assign({}, process.env, {
    DAO_RATE_LIMIT_MARKER: path.join(BASE, tag, "rate-limit-interrupt.json"),
    DAO_RATE_LIMIT_STATE_SUBDIR: path.posix.join(TAG, tag, "state"),
  });
}
function markerPath(tag) { return path.join(BASE, tag, "rate-limit-interrupt.json"); }
// ⚠ 日志落点是 `<被跑的那个 hook 的 ROOT>/_tmp/<subdir>/`，而 mutant 的 ROOT 在沙箱里、
// 不是 REPO —— 按 REPO 写死会让 mutant 的 canary 永远读到空文件（首版就是这么假红的）。
// 故按**被跑的那个文件**反推 ROOT，两种情形共用一套算法。
function rootOf(hookPath) { return path.resolve(path.dirname(hookPath), "..", ".."); }
function firedPath(tag, hookPath) { return path.join(rootOf(hookPath || REAL_HOOK), "_tmp", TAG, tag, "state", "fired.log"); }
function errorsPath(tag, hookPath) { return path.join(rootOf(hookPath || REAL_HOOK), "_tmp", TAG, tag, "state", "errors.log"); }

function run(hookPath, payload, tag, rawInput) {
  const input = rawInput != null ? rawInput : JSON.stringify(payload);
  const r = spawnSync(process.execPath, [hookPath], { input, encoding: "utf8", env: envFor(tag) });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) { return null; } }
function firedLines(tag, hookPath) {
  try {
    return fs.readFileSync(firedPath(tag, hookPath), "utf8").split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}
function payloadOf(over) {
  return Object.assign({
    session_id: "sid-" + TAG,
    transcript_path: "C:/fake/transcript.jsonl",
    cwd: REPO,
    hook_event_name: "StopFailure",
    error: "rate_limit",
    error_details: "429 Too Many Requests",
    last_assistant_message: "API Error: Rate limit reached",
  }, over || {});
}

console.log("\n=== 正态 · rate_limit：写标记 + 记日志 ===");
{
  const tag = "rate";
  const r = run(REAL_HOOK, payloadOf({ last_assistant_message: "API Error: Rate limit reached · 约 3 小时 12 分钟后重置" }), tag);
  check("exit 0（本事件退出码被宿主忽略，但仍不许非 0）", r.code === 0, "code=" + r.code);
  const m = readJson(markerPath(tag));
  check("标记文件已写出且是合法 JSON", m !== null);
  check("标记字段齐全（at / error / reset_estimate_s / raw / session_id —— spec a 段列的那五格）",
    m && typeof m.at === "string" && m.error === "rate_limit" &&
    Object.prototype.hasOwnProperty.call(m, "reset_estimate_s") &&
    typeof m.raw === "string" && m.session_id === "sid-" + TAG,
    "marker=" + JSON.stringify(m));
  check("中文拼车式解析出 3 小时 12 分钟 = 11520 秒", m && m.reset_estimate_s === 11520, "得 " + (m && m.reset_estimate_s));
  check("reset_parse 记下是哪一式命中（真实语料攒够后才判得出英文式有没有用）",
    m && m.reset_parse === "cn-carpool", "得 " + (m && m.reset_parse));
  check("raw 摘录同时含 error_details 与 last_assistant_message 两侧内容",
    m && /429/.test(m.raw) && /Rate limit reached/.test(m.raw), "raw=" + (m && m.raw));
  const f = firedLines(tag);
  check("fired.log 记一行且 marked=true", f.length === 1 && f[0].marked === true, "fired=" + JSON.stringify(f));
}

console.log("\n=== 正态 · overloaded：同样写标记（matcher 覆盖的两种之一）===");
{
  const tag = "overloaded";
  run(REAL_HOOK, payloadOf({ error: "overloaded", error_details: "Overloaded", last_assistant_message: "API Error: Overloaded" }), tag);
  const m = readJson(markerPath(tag));
  check("overloaded → 写标记", m !== null && m.error === "overloaded", "marker=" + JSON.stringify(m));
  check("解析不出重置时间 → reset_estimate_s 记 null（标记照写，不因此跳过）",
    m && m.reset_estimate_s === null && m.reset_parse === null, "marker=" + JSON.stringify(m));
}

console.log("\n=== 负态 · 其余 error 类型：不写标记，但仍记日志（不写标记 ≠ 不记账）===");
{
  // 这一组是「hook 内再判一次」那道防御的正控：注册层 matcher 若哪天被改成 "*"，
  // 它是唯一挡住「任何 API 错误都伪装成限流去唤醒探针」的东西。
  const NEG = ["server_error", "authentication_failed", "billing_error", "invalid_request",
    "model_not_found", "max_output_tokens", "oauth_org_not_allowed", "unknown"];
  for (const err of NEG) {
    const tag = "neg-" + err;
    const r = run(REAL_HOOK, payloadOf({ error: err, error_details: err, last_assistant_message: "API Error: " + err }), tag);
    const exists = fs.existsSync(markerPath(tag));
    const f = firedLines(tag);
    check(`负控：error=${err} → 不写标记`, !exists, "标记竟被写出");
    check(`负控：error=${err} → fired.log 仍记一行 marked=false`,
      f.length === 1 && f[0].marked === false && f[0].error === err, "fired=" + JSON.stringify(f));
    check(`负控：error=${err} → exit 0`, r.code === 0, "code=" + r.code);
  }
}
{
  // error 字段缺席：宿主实测会填 "unknown"，但缺席时本 hook 也必须按 unknown 走（不写标记）
  const tag = "neg-missing-error";
  const p = payloadOf(); delete p.error;
  run(REAL_HOOK, p, tag);
  check("负控：payload 没有 error 字段 → 按 unknown 处理，不写标记", !fs.existsSync(markerPath(tag)));
}

console.log("\n=== fail-open · 坏输入不许炸，且不许静默 ===");
{
  const tag = "badjson";
  const r = run(REAL_HOOK, null, tag, "这不是 JSON{{{");
  check("坏 stdin → exit 0（fail-open）", r.code === 0, "code=" + r.code);
  check("坏 stdin → 不写标记", !fs.existsSync(markerPath(tag)));
  check("坏 stdin → 写 errors.log（出错必须出声，静默是这个 hook 最坏的死法）",
    fs.existsSync(errorsPath(tag)), "errors.log 不存在");
  check("坏 stdin → stderr 有留痕", /解析 stdin 失败/.test(r.err), "err=" + r.err.slice(0, 120));
}
{
  const tag = "forceerr";
  const env = envFor(tag); env.DAO_RATE_LIMIT_FORCE_ERROR = "1";
  const r = spawnSync(process.execPath, [REAL_HOOK], { input: JSON.stringify(payloadOf()), encoding: "utf8", env });
  check("故障注入（DAO_RATE_LIMIT_FORCE_ERROR=1）→ 仍 exit 0", r.status === 0, "code=" + r.status);
  check("故障注入 → 不写标记且留痕", !fs.existsSync(markerPath(tag)) && fs.existsSync(errorsPath(tag)));
}

console.log("\n=== 幂等：连发两次不炸，后一次覆盖前一次 ===");
{
  const tag = "idem";
  run(REAL_HOOK, payloadOf({ last_assistant_message: "API Error: Rate limit reached · 约 1 小时后重置" }), tag);
  const first = readJson(markerPath(tag));
  const r2 = run(REAL_HOOK, payloadOf({ last_assistant_message: "API Error: Rate limit reached · 约 2 小时 30 分钟后重置" }), tag);
  const second = readJson(markerPath(tag));
  check("第二次 exit 0（不因标记已存在而炸）", r2.code === 0, "code=" + r2.code);
  check("第一次 = 3600s / 第二次 = 9000s（后写覆盖前写）",
    first && first.reset_estimate_s === 3600 && second && second.reset_estimate_s === 9000,
    "first=" + (first && first.reset_estimate_s) + " second=" + (second && second.reset_estimate_s));
  check("fired.log 攒了两行（标记覆盖，但账不覆盖）", firedLines(tag).length === 2);
}

console.log("\n=== 解析式单元：两式各自的正控 + 负控（语料只取 spec a 段那两式）===");
{
  const { parseResetSeconds, MAX_RESET_S } = require(REAL_HOOK);
  const NOW = Date.UTC(2026, 7, 8, 6, 0, 0); // 固定基准，免得 epoch 那一式随时钟漂

  const POS = [
    ["中文·时+分", "约 3 小时 12 分钟后重置", 11520, "cn-carpool"],
    ["中文·只有分", "约 45 分钟后重置", 2700, "cn-carpool"],
    ["中文·只有时", "约 5 小时后重置", 18000, "cn-carpool"],
    ["中文·无空格", "约3小时12分钟后重置", 11520, "cn-carpool"],
    ["中文·「个小时」变体", "约 2 个小时后重置", 7200, "cn-carpool"],
    ["中文·嵌在长句里", "API Error: 额度用尽，约 1 小时 5 分钟后重置，请稍候", 3900, "cn-carpool"],
    ["英文·类门命中且带 epoch", "Claude AI usage limit reached|" + Math.floor(NOW / 1000 + 7200), 7200, "en-epoch"],
  ];
  for (const [name, text, sec, how] of POS) {
    const r = parseResetSeconds(text, NOW);
    check("正控：" + name, r.seconds === sec && r.how === how, "得 " + JSON.stringify(r));
  }

  const NEG = [
    ["文档给的英文实例①（不含重置时间）", "API Error: Rate limit reached"],
    ["文档给的英文实例②（429，三位数不是 epoch）", "429 Too Many Requests"],
    ["两个实例拼起来仍解析不出", "429 Too Many Requests API Error: Rate limit reached"],
    ["epoch 在场但不是限额类报错（类门挡住，不自造第三式）", "internal server error at 1786500000"],
    ["中文句式在但没有数字", "额度用尽，稍后重置"],
    ["毫秒时间戳（13 位）不当 epoch 读", "usage limit reached at 1786514400000"],
    ["空串", ""],
    ["null", null],
  ];
  for (const [name, text] of NEG) {
    const r = parseResetSeconds(text, NOW);
    check("负控：" + name + " → null", r.seconds === null && r.how === null, "得 " + JSON.stringify(r));
  }

  // 上界与下界：**两侧都夹住**，不只验「能解析出」
  check("边界：epoch 已经过去（负数）→ null",
    parseResetSeconds("usage limit reached|" + Math.floor(NOW / 1000 - 60), NOW).seconds === null);
  check("边界：超过上界 " + MAX_RESET_S + "s 的中文时长 → null（挡的是「这个数根本不是时间」）",
    parseResetSeconds("约 200 小时后重置", NOW).seconds === null);
  check("边界：恰在上界内（7 天差 1 小时）→ 仍解析得出",
    parseResetSeconds("约 167 小时后重置", NOW).seconds === 167 * 3600);
}

console.log("\n=== --selfcheck 不许崩（它读真实 settings.json，故只断言形态不断言结论）===");
{
  // 刻意不断言退出码是 0 还是 1：注册前是 1、注册后是 0，两者都是**正确**结果，
  // 钉死任何一个都会在帅完成注册的那一刻变成假红/假绿。这里只钉「它不崩、报文有两段」。
  const r = spawnSync(process.execPath, [REAL_HOOK, "--selfcheck"], { input: "", encoding: "utf8", env: envFor("selfcheck") });
  check("--selfcheck 退出码 ∈ {0,1}（不是崩溃码）", r.status === 0 || r.status === 1, "code=" + r.status);
  check("--selfcheck 打印带 hook 名的报头", /dao-rate-limit-sentinel --selfcheck/.test(r.stdout || ""), "out=" + (r.stdout || "").slice(0, 160));
}

console.log("\n=== mutation · 三个方向（锚点单行、断言与 replace 同一个字符串）===");
{
  const SRC = fs.readFileSync(REAL_HOOK, "utf8");
  const SHA_BEFORE = crypto.createHash("sha256").update(SRC).digest("hex");

  // 沙箱：把 hook 与它**自己声明的**相对依赖一起拷进去（依赖清单从源码扫出来，不手写——
  // 手写的清单会在有人加一个 require 的那天悄悄过期，而症状是「测试仍在跑，测的是个残废」）。
  function relRequiresOf(src) {
    return [...src.matchAll(/require\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)].map((m) => m[1]);
  }
  function mutantHook(tag, anchor, replacement) {
    check(`mutation 靶点在源码里唯一存在（${tag}）`, SRC.split(anchor).length === 2,
      `出现 ${SRC.split(anchor).length - 1} 次`);
    const root = path.join(BASE, "mut-" + tag);
    const hooksDir = path.join(root, "ccswitch", "hooks");
    fs.mkdirSync(hooksDir, { recursive: true });
    const deps = relRequiresOf(SRC);
    check(`沙箱前提：${tag} 的相对依赖能逐个定位（加了新依赖会在这里当场变红）`,
      deps.length > 0 && deps.every((d) => fs.existsSync(path.resolve(path.dirname(REAL_HOOK), d))),
      "deps=" + JSON.stringify(deps));
    for (const d of deps) {
      const from = path.resolve(path.dirname(REAL_HOOK), d);
      const to = path.resolve(hooksDir, d);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
    fs.writeFileSync(path.join(hooksDir, "dao-rate-limit-sentinel.js"), SRC.replace(anchor, replacement), "utf8");
    return path.join(hooksDir, "dao-rate-limit-sentinel.js");
  }

  // 方向①「放松」：把写标记的 error 集合扩面 ⇒ 本不该写标记的 server_error 开始写
  //   ⇒ 证明上面那一整组负控**真的在测判据**，不是永真。
  {
    const ANCHOR = 'const MARKED_ERRORS = new Set(["rate_limit", "overloaded"]);';
    const h = mutantHook("loosen", ANCHOR, 'const MARKED_ERRORS = new Set(["rate_limit", "overloaded", "server_error"]);');
    run(REAL_HOOK, payloadOf({ error: "server_error" }), "mutL-before");
    run(h, payloadOf({ error: "server_error" }), "mutL-after");
    check("放松方向：真文件对 server_error 不写标记，扩面后写了 ⇒ 负控组有判别力",
      !fs.existsSync(markerPath("mutL-before")) && fs.existsSync(markerPath("mutL-after")));
    check("canary：变异体还活着（对 rate_limit 仍照常写标记，不是整个 hook 崩了）",
      (run(h, payloadOf(), "mutL-canary"), fs.existsSync(markerPath("mutL-canary"))));
  }

  // 方向②「保留字面但使其不执行」：`if (marked)` 架空 ⇒ 正控停止写标记
  //   刻意不用「整段删除」：删掉 code review 一眼看得见，「留着但不执行」才骗得过人眼。
  {
    const ANCHOR = "  if (marked) {";
    const h = mutantHook("disable", ANCHOR, "  if (false && marked) {");
    run(REAL_HOOK, payloadOf(), "mutD-before");
    run(h, payloadOf(), "mutD-after");
    check("关掉方向：真文件写标记，判据被架空后不写 ⇒ 正控组有判别力",
      fs.existsSync(markerPath("mutD-before")) && !fs.existsSync(markerPath("mutD-after")));
    check("canary：变异体还活着（fired.log 照常记账，证明进程跑到了末尾）",
      firedLines("mutD-after", h).length === 1, "fired=" + JSON.stringify(firedLines("mutD-after", h)));
  }

  // 方向③「结果不被消费」：解析式改成永不命中 ⇒ 标记照写、字段照在，只是值恒为 null
  //   —— 这一向骗得过「标记文件存在吗 / 字段齐吗」这类断言，只有值断言逮得住。
  {
    const ANCHOR = "const CN_RESET_RE = /约\\s*(?:(\\d+)\\s*个?\\s*小时)?\\s*(?:(\\d+)\\s*分钟)?\\s*后?\\s*重置/;";
    const h = mutantHook("blindparse", ANCHOR, "const CN_RESET_RE = /(?!)/;");
    const p = payloadOf({ last_assistant_message: "API Error: Rate limit reached · 约 3 小时 12 分钟后重置" });
    run(REAL_HOOK, p, "mutP-before");
    run(h, p, "mutP-after");
    const before = readJson(markerPath("mutP-before"));
    const after = readJson(markerPath("mutP-after"));
    check("解析式方向：真文件解析出 11520s，改瞎后记 null ⇒ 值断言有判别力",
      before && before.reset_estimate_s === 11520 && after && after.reset_estimate_s === null,
      "before=" + (before && before.reset_estimate_s) + " after=" + (after && after.reset_estimate_s));
    check("canary：变异体还活着（标记文件照写、字段照齐 —— 正是这一向骗得过存在性断言的证明）",
      after !== null && after.error === "rate_limit" && typeof after.raw === "string");
  }

  check("canary 恒等：真 hook 文件全程未被改动",
    crypto.createHash("sha256").update(fs.readFileSync(REAL_HOOK)).digest("hex") === SHA_BEFORE);
}

console.log("\n=== 跨文件一致性：两个 hook 必须认同一个标记路径 ===");
{
  // 哨兵写 A、闸门读 B 这种错，**两边各自的日志都正常**，只有真限流那一次才会现形，
  // 而那一次没人在看。故在这里钉死：两份源码里那行默认路径逐字相同。
  const gate = fs.readFileSync(path.join(REPO, "ccswitch", "hooks", "dao-probe-gate.js"), "utf8");
  const LINE = 'const MARKER_PATH = process.env.DAO_RATE_LIMIT_MARKER || path.join(ROOT, "_tmp", "rate-limit-interrupt.json");';
  check("哨兵与闸门的 MARKER_PATH 定义逐字相同（env 名 + 默认路径都同）",
    fs.readFileSync(REAL_HOOK, "utf8").includes(LINE) && gate.includes(LINE));
}

try { fs.rmSync(BASE, { recursive: true, force: true }); } catch (_) {}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
