// dao-rate-limit-sentinel 两态自证 · 端到端 + 解析式单元
//
// 跑法：node tests/rate-limit-sentinel.tests.js   （全绿 exit 0，任一红 exit 1）
//
// 验的层：「哪些 error 写标记」判据 + 两式重置时间解析 + fail-open 三条路径 + deaths_24h
// 窗口边界（每格正控 + 先破再验 mutation）。
// 端到端跑真文件（落盘面全部 env 覆写进本次沙箱：DAO_RATE_LIMIT_MARKER / _STATE_SUBDIR /
// _MIRROR —— 生产那份 fired.log 是真实限流样本的耐久数据，掺进合成样本会污染复盘结论）。
// mutation 锚点全是单行（CRLF/LF 咬不到），且「锚点仍在」断言与喂给 replace() 的是同一个
// 字符串对象；每个 mutant 配 canary（变异体还活着，不是整个 hook 崩了）。

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

function mirrorPath(tag) { return path.join(BASE, tag, "mirror", "fired.log"); }
function envFor(tag) {
  return Object.assign({}, process.env, {
    DAO_RATE_LIMIT_MARKER: path.join(BASE, tag, "rate-limit-interrupt.json"),
    DAO_RATE_LIMIT_STATE_SUBDIR: path.posix.join(TAG, tag, "state"),
    DAO_RATE_LIMIT_MIRROR: mirrorPath(tag),
  });
}
function markerPath(tag) { return path.join(BASE, tag, "rate-limit-interrupt.json"); }
function mirrorLines(tag) {
  try {
    return fs.readFileSync(mirrorPath(tag), "utf8").split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}
// 日志落点是 `<被跑的那个 hook 的 ROOT>/_tmp/<subdir>/`，mutant 的 ROOT 在沙箱里 ⇒ 按被跑文件反推。
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
function seedFiredLog(tag, hookPath, records) {
  const p = firedPath(tag, hookPath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
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

// ── mutation 沙箱（只此一份）──────────────────────────────────────────────────
const SRC = fs.readFileSync(REAL_HOOK, "utf8");
const SHA_BEFORE = crypto.createHash("sha256").update(SRC).digest("hex");
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
  check(`沙箱前提：${tag} 的相对依赖能逐个定位`, deps.length > 0 && deps.every((d) => fs.existsSync(path.resolve(path.dirname(REAL_HOOK), d))));
  for (const d of deps) {
    const from = path.resolve(path.dirname(REAL_HOOK), d);
    const to = path.resolve(hooksDir, d);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  fs.writeFileSync(path.join(hooksDir, "dao-rate-limit-sentinel.js"), SRC.replace(anchor, replacement), "utf8");
  return path.join(hooksDir, "dao-rate-limit-sentinel.js");
}

console.log("\n=== 正态 · rate_limit：写标记 + 记日志 ===");
{
  const tag = "rate";
  const r = run(REAL_HOOK, payloadOf({ last_assistant_message: "API Error: Rate limit reached · 约 3 小时 12 分钟后重置" }), tag);
  const m = readJson(markerPath(tag));
  check("exit 0 + 标记是合法 JSON + 承重字段值对（error/raw/session_id/signature）",
    r.code === 0 && m !== null && m.error === "rate_limit" && typeof m.raw === "string" &&
    m.session_id === "sid-" + TAG && m.signature === "[dao-rate-limit-sentinel v1]");
  check("中文拼车式解析出 11520s + reset_parse 记下是哪一式 + reset_estimate_at = at + s（±5s）",
    m && m.reset_estimate_s === 11520 && m.reset_parse === "cn-carpool" &&
    typeof m.reset_estimate_at === "string" &&
    Math.abs((Date.parse(m.reset_estimate_at) - Date.parse(m.at)) - m.reset_estimate_s * 1000) <= 5000);
  check("raw 摘录含 error_details 与 last_assistant_message 两侧",
    m && /429/.test(m.raw) && /Rate limit reached/.test(m.raw));
  const f = firedLines(tag);
  const mir = mirrorLines(tag);
  check("fired.log 与镜像域各记一行 marked:true，镜像带 mirror:true 且与主账同源",
    f.length === 1 && f[0].marked === true && mir.length === 1 && mir[0].mirror === true &&
    mir[0].at === f[0].at && mir[0].error === f[0].error);
  check("deaths_24h = 1（这个 tag 的 fired.log 此前是空的，含本次死亡）", m && m.deaths_24h === 1);
}

console.log("\n=== deaths_24h 窗口边界（每格正控 + 先破再验）===");
{
  // 负控种子：25h 前 marked:true（窗外）+ 1h 前 marked:false（非死亡）⇒ 只数到本次真实死亡
  const OLD_MARKED = { at: new Date(Date.now() - 25 * 3600 * 1000).toISOString(), marked: true, error: "rate_limit" };
  const RECENT_UNMARKED = { at: new Date(Date.now() - 1 * 3600 * 1000).toISOString(), marked: false, error: "server_error" };
  const tag = "deaths-window";
  seedFiredLog(tag, REAL_HOOK, [OLD_MARKED, RECENT_UNMARKED]);
  run(REAL_HOOK, payloadOf(), tag);
  const m = readJson(markerPath(tag));
  check("窗外死亡 + 非死亡都不计入 ⇒ deaths_24h = 1（fired.log 共 3 行，没把种子行数抄过来）",
    m && m.deaths_24h === 1 && firedLines(tag).length === 3);
  {
    const ANCHOR = "        if (Number.isFinite(t) && t >= cutoff && t <= nowMs + CLOCK_SKEW_TOLERANCE_MS) n++;";
    const h = mutantHook("window-blind", ANCHOR, "        if (Number.isFinite(t)) n++;");
    const tagM = "deaths-window-mut";
    seedFiredLog(tagM, h, [OLD_MARKED, RECENT_UNMARKED]);
    const rm = spawnSync(process.execPath, [h], { input: JSON.stringify(payloadOf()), encoding: "utf8", env: envFor(tagM) });
    const mm = readJson(markerPath(tagM));
    check("先破再验：窗口判据架空 ⇒ 窗外死亡也被计入，deaths_24h=2；canary：变异体还活着（marker 照写）",
      mm && mm.deaths_24h === 2 && rm.status === 0 && mm.error === "rate_limit");
  }
}
{
  // 未来时间戳不得永久计入（上界）+ 时钟回拨容差 5 分钟（容差内计入 / 容差外排除）
  const FUTURE_MARKED = { at: new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString(), marked: true, error: "rate_limit" };
  const tag = "deaths-future";
  seedFiredLog(tag, REAL_HOOK, [FUTURE_MARKED]);
  run(REAL_HOOK, payloadOf(), tag);
  check("未来 10 天不计入 ⇒ deaths_24h = 1", readJson(markerPath(tag)) && readJson(markerPath(tag)).deaths_24h === 1);
  {
    const ANCHOR = "        if (Number.isFinite(t) && t >= cutoff && t <= nowMs + CLOCK_SKEW_TOLERANCE_MS) n++;";
    const h = mutantHook("future-nocap", ANCHOR, "        if (Number.isFinite(t) && t >= cutoff) n++;");
    const tagM = "deaths-future-mut";
    seedFiredLog(tagM, h, [FUTURE_MARKED]);
    const rm = spawnSync(process.execPath, [h], { input: JSON.stringify(payloadOf()), encoding: "utf8", env: envFor(tagM) });
    check("先破再验：撤上界 ⇒ 未来记录被计入，deaths_24h=2（canary：marker 照写）",
      readJson(markerPath(tagM)) && readJson(markerPath(tagM)).deaths_24h === 2 && rm.status === 0);
  }
}
{
  const NEAR = { at: new Date(Date.now() + 3 * 60 * 1000).toISOString(), marked: true, error: "rate_limit" };
  const BEYOND = { at: new Date(Date.now() + 10 * 60 * 1000).toISOString(), marked: true, error: "rate_limit" };
  const tag = "deaths-skew";
  seedFiredLog(tag, REAL_HOOK, [NEAR, BEYOND]);
  run(REAL_HOOK, payloadOf(), tag);
  check("容差内（+3 分钟）计入、容差外（+10 分钟）排除 ⇒ deaths_24h = 2（两条 + 本次）",
    readJson(markerPath(tag)) && readJson(markerPath(tag)).deaths_24h === 2);
  {
    const ANCHOR = "        if (Number.isFinite(t) && t >= cutoff && t <= nowMs + CLOCK_SKEW_TOLERANCE_MS) n++;";
    const h = mutantHook("skew-zeroed", ANCHOR, "        if (Number.isFinite(t) && t >= cutoff && t <= nowMs) n++;");
    const tagM = "deaths-skew-mut";
    seedFiredLog(tagM, h, [NEAR, BEYOND]);
    const rm = spawnSync(process.execPath, [h], { input: JSON.stringify(payloadOf()), encoding: "utf8", env: envFor(tagM) });
    check("先破再验：容差收紧回 0 ⇒ +3 分钟也被排除，deaths_24h 从 2 变 1", readJson(markerPath(tagM)) && readJson(markerPath(tagM)).deaths_24h === 1 && rm.status === 0);
  }
}
{
  // issue #259：容差数字本身没被钉死 —— 上面那组 +3min/+10min 样本离 5 分钟边界留余量
  // （正控侧 2 分钟、负控侧 5 分钟），容差被悄悄改成 4~8 分钟之间任何值，那两条正控/负控
  // 都测不出来（PR #258 对抗判词实测表：2min 变红、4/7/8min 全绿、12min 变红）。这里把
  // 余量收到 10 秒，直接夹住 5 分钟这个具体数字。
  // 10 秒余量是否会 flaky：前置实测 —— 本批重测 60 次真实 spawnSync（另 60 次含 4 路
  // CPU 满载背景干扰模拟繁忙环境），量的是「种子时间戳」到「hook 内部 Date.now()」的漂移
  // （marker.at 作代理，与 countDeaths24h 的 Date.now() 同进程毫秒级相隔）：
  //   无负载 n=60 min=28ms max=35ms avg=30.6ms；4 路满载 n=60 min=29ms max=70ms avg=36.1ms
  // ——10s 余量有 >140 倍安全边际，不会 flaky（测量脚本与红集证据见 PR body，未入库——
  // 一次性前置验证，非回归断言）。
  const NEAR_INCLUDE = { at: new Date(Date.now() + 4 * 60 * 1000 + 50 * 1000).toISOString(), marked: true, error: "rate_limit" }; // +4:50
  const NEAR_EXCLUDE = { at: new Date(Date.now() + 5 * 60 * 1000 + 10 * 1000).toISOString(), marked: true, error: "rate_limit" }; // +5:10
  const tagIn = "clock-skew-tight-include";
  const tagEx = "clock-skew-tight-exclude";
  seedFiredLog(tagIn, REAL_HOOK, [NEAR_INCLUDE]);
  seedFiredLog(tagEx, REAL_HOOK, [NEAR_EXCLUDE]);
  run(REAL_HOOK, payloadOf(), tagIn);
  run(REAL_HOOK, payloadOf(), tagEx);
  check("+4:50（容差边界内侧 10s）计入 ⇒ deaths_24h = 2",
    readJson(markerPath(tagIn)) && readJson(markerPath(tagIn)).deaths_24h === 2);
  check("+5:10（容差边界外侧 10s）排除 ⇒ deaths_24h = 1",
    readJson(markerPath(tagEx)) && readJson(markerPath(tagEx)).deaths_24h === 1);
  {
    // 先破再验①：容差改成 4 分钟（issue #259 表里那个盲点）⇒ +4:50 不再落在容差内，
    // 上面「计入」那条正控必须翻面。
    const ANCHOR = "const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;";
    const h = mutantHook("clock-skew-4min", ANCHOR, "const CLOCK_SKEW_TOLERANCE_MS = 4 * 60 * 1000;");
    const tagM = "clock-skew-tight-include-mut4";
    seedFiredLog(tagM, h, [NEAR_INCLUDE]);
    const rm = spawnSync(process.execPath, [h], { input: JSON.stringify(payloadOf()), encoding: "utf8", env: envFor(tagM) });
    check("先破再验：容差改成 4 分钟（issue #259 表格盲点之一）⇒ +4:50 被排除，deaths_24h 从 2 变 1；canary：marker 照写",
      readJson(markerPath(tagM)) && readJson(markerPath(tagM)).deaths_24h === 1 && rm.status === 0 &&
      readJson(markerPath(tagM)).error === "rate_limit");
  }
  {
    // 先破再验②：容差改成 8 分钟（issue #259 表里另一个盲点）⇒ +5:10 落进容差内，
    // 上面「排除」那条负控必须翻面。
    const ANCHOR = "const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;";
    const h = mutantHook("clock-skew-8min", ANCHOR, "const CLOCK_SKEW_TOLERANCE_MS = 8 * 60 * 1000;");
    const tagM = "clock-skew-tight-exclude-mut8";
    seedFiredLog(tagM, h, [NEAR_EXCLUDE]);
    const rm = spawnSync(process.execPath, [h], { input: JSON.stringify(payloadOf()), encoding: "utf8", env: envFor(tagM) });
    check("先破再验：容差改成 8 分钟（issue #259 表格另一个盲点）⇒ +5:10 被计入，deaths_24h 从 1 变 2；canary：marker 照写",
      readJson(markerPath(tagM)) && readJson(markerPath(tagM)).deaths_24h === 2 && rm.status === 0 &&
      readJson(markerPath(tagM)).error === "rate_limit");
  }
}
{
  // 窗口收紧方向（23h 正控）与 truthy 判定（marked === true 不许松）
  const D23 = { at: new Date(Date.now() - 23 * 3600 * 1000).toISOString(), marked: true, error: "rate_limit" };
  const TRUTHY = { at: new Date(Date.now() - 1 * 3600 * 1000).toISOString(), marked: 1, error: "rate_limit" };
  const tag = "deaths-23h-truthy";
  seedFiredLog(tag, REAL_HOOK, [D23, TRUTHY]);
  run(REAL_HOOK, payloadOf(), tag);
  check("23h 前计入 + marked:1（truthy 但非严格 true）不计入 ⇒ deaths_24h = 2（D23 + 本次）",
    readJson(markerPath(tag)) && readJson(markerPath(tag)).deaths_24h === 2);
  {
    const ANCHOR = "const DEATHS_WINDOW_MS = 24 * 3600 * 1000;";
    const h = mutantHook("window-shrink", ANCHOR, "const DEATHS_WINDOW_MS = 1 * 3600 * 1000;");
    const tagM = "deaths-23h-mut";
    seedFiredLog(tagM, h, [D23, TRUTHY]);
    const rm = spawnSync(process.execPath, [h], { input: JSON.stringify(payloadOf()), encoding: "utf8", env: envFor(tagM) });
    check("先破再验：窗口收到 1h ⇒ 23h 前掉出窗口，deaths_24h=1", readJson(markerPath(tagM)) && readJson(markerPath(tagM)).deaths_24h === 1 && rm.status === 0);
    const ANCHOR2 = "      if (r && r.marked === true) {";
    const h2 = mutantHook("marked-loosen", ANCHOR2, "      if (r && r.marked) {");
    const tagM2 = "deaths-truthy-mut";
    seedFiredLog(tagM2, h2, [TRUTHY]);
    const rm2 = spawnSync(process.execPath, [h2], { input: JSON.stringify(payloadOf()), encoding: "utf8", env: envFor(tagM2) });
    check("先破再验：===true 松成 truthy ⇒ marked:1 被计入，deaths_24h=2", readJson(markerPath(tagM2)) && readJson(markerPath(tagM2)).deaths_24h === 2 && rm2.status === 0);
  }
}

console.log("\n=== overloaded / 负态 / 幂等 ===");
{
  const tag = "overloaded";
  run(REAL_HOOK, payloadOf({ error: "overloaded", error_details: "Overloaded", last_assistant_message: "API Error: Overloaded" }), tag);
  const m = readJson(markerPath(tag));
  check("overloaded → 写标记；解析不出重置时间 → reset_estimate_s=null（标记照写）",
    m && m.error === "overloaded" && m.reset_estimate_s === null && m.reset_parse === null);
  const tag2 = "neg";
  run(REAL_HOOK, payloadOf({ error: "server_error", error_details: "server_error", last_assistant_message: "API Error: server_error" }), tag2);
  const f = firedLines(tag2);
  check("非限流 error → 不写标记，fired.log 仍记一行 marked=false（不写标记 ≠ 不记账）",
    !fs.existsSync(markerPath(tag2)) && f.length === 1 && f[0].marked === false && f[0].error === "server_error");
  const p = payloadOf(); delete p.error;
  run(REAL_HOOK, p, "neg-missing");
  check("payload 缺 error 字段 → 按 unknown 走，不写标记", !fs.existsSync(markerPath("neg-missing")));
  const tagI = "idem";
  run(REAL_HOOK, payloadOf({ last_assistant_message: "API Error: Rate limit reached · 约 1 小时后重置" }), tagI);
  const first = readJson(markerPath(tagI));
  const r2 = run(REAL_HOOK, payloadOf({ last_assistant_message: "API Error: Rate limit reached · 约 2 小时 30 分钟后重置" }), tagI);
  const second = readJson(markerPath(tagI));
  check("幂等：第二次 exit 0，标记覆盖（3600→9000）但 fired.log 攒两行、deaths_24h 1→2",
    r2.code === 0 && first.reset_estimate_s === 3600 && second.reset_estimate_s === 9000 &&
    firedLines(tagI).length === 2 && first.deaths_24h === 1 && second.deaths_24h === 2);
}

console.log("\n=== fail-open · 坏输入 + 故障注入 ===");
{
  const tag = "badjson";
  const r = run(REAL_HOOK, null, tag, "这不是 JSON{{{");
  const mir = mirrorLines(tag);
  check("坏 stdin → exit 0、不写标记、写 errors.log、stderr 留痕、镜像也记一行（M7 第 2 个调用点）",
    r.code === 0 && !fs.existsSync(markerPath(tag)) && fs.existsSync(errorsPath(tag)) &&
    /解析 stdin 失败/.test(r.err) && mir.length === 1 && mir[0].synthetic === true);
  {
    const ANCHOR = "    mirrorRecord(badRec);";
    const h = mutantHook("badpath-no-mirror", ANCHOR, "    if (false) mirrorRecord(badRec);");
    const tagM = "badjson-mut";
    const rm = run(h, null, tagM, "这不是 JSON{{{");
    check("先破再验：坏 stdin 路径的镜像调用架空 ⇒ 镜像域零记录（canary：errors.log 照写）",
      mirrorLines(tagM).length === 0 && rm.code === 0 && fs.existsSync(errorsPath(tagM, h)));
  }
  const env = envFor("forceerr"); env.DAO_RATE_LIMIT_FORCE_ERROR = "1";
  const rf = spawnSync(process.execPath, [REAL_HOOK], { input: JSON.stringify(payloadOf()), encoding: "utf8", env });
  check("故障注入 → 仍 exit 0、不写标记且留痕", rf.status === 0 && !fs.existsSync(markerPath("forceerr")) && fs.existsSync(errorsPath("forceerr")));
}

console.log("\n=== 解析式单元（两式正负控 + 边界）===");
{
  const { parseResetSeconds, MAX_RESET_S } = require(REAL_HOOK);
  const NOW = Date.UTC(2026, 7, 8, 6, 0, 0);
  const pos = [
    ["中文·时+分", "约 3 小时 12 分钟后重置", 11520, "cn-carpool"],
    ["中文·嵌在长句里", "API Error: 额度用尽，约 1 小时 5 分钟后重置，请稍候", 3900, "cn-carpool"],
    ["英文·类门命中且带 epoch", "Claude AI usage limit reached|" + Math.floor(NOW / 1000 + 7200), 7200, "en-epoch"],
  ];
  for (const [name, text, sec, how] of pos) {
    const r = parseResetSeconds(text, NOW);
    check("正控：" + name, r.seconds === sec && r.how === how, "得 " + JSON.stringify(r));
  }
  for (const [name, text] of [
    ["英文实例（不含重置时间）", "API Error: Rate limit reached"],
    ["epoch 在场但不是限额类报错", "internal server error at 1786500000"],
    ["毫秒时间戳不当 epoch 读", "usage limit reached at 1786514400000"],
    ["中文句式但没有数字", "额度用尽，稍后重置"],
    ["空串", ""],
  ]) {
    const r = parseResetSeconds(text, NOW);
    check("负控：" + name + " → null", r.seconds === null && r.how === null, "得 " + JSON.stringify(r));
  }
  check("边界：epoch 已过去 → null；超过上界 → null；恰在上界内 → 仍解析得出",
    parseResetSeconds("usage limit reached|" + Math.floor(NOW / 1000 - 60), NOW).seconds === null &&
    parseResetSeconds("约 200 小时后重置", NOW).seconds === null &&
    parseResetSeconds("约 167 小时后重置", NOW).seconds === 167 * 3600);
}

console.log("\n=== 留痕单点加固 + 外层 catch + #201 镜像吞/不吞 ===");
{
  // 主域坏掉（父路径占成普通文件）⇒ 镜像照记；两个域一起坏 ⇒ 仍 exit 0
  const blocker = path.join(BASE, "brokenstate");
  fs.writeFileSync(blocker, "我是一个普通文件，不是目录", "utf8");
  const env = Object.assign({}, process.env, {
    DAO_RATE_LIMIT_MARKER: path.join(BASE, "brokenmarker", "rate-limit-interrupt.json"),
    DAO_RATE_LIMIT_STATE_SUBDIR: path.posix.join(TAG, "brokenstate/state"),
    DAO_RATE_LIMIT_MIRROR: path.join(BASE, "brokenstate-mirror", "fired.log"),
  });
  const r = spawnSync(process.execPath, [REAL_HOOK], { input: JSON.stringify(payloadOf({ last_assistant_message: "API Error: Rate limit reached · 约 1 小时后重置" })), encoding: "utf8", env });
  const mir = (() => { try { return fs.readFileSync(path.join(BASE, "brokenstate-mirror", "fired.log"), "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; } })();
  check("主域坏掉 → 仍 exit 0、镜像照记一行且带重置估时（加固前这里零条）",
    r.status === 0 && mir.length === 1 && mir[0].error === "rate_limit" && mir[0].mirror === true && mir[0].reset_estimate_s === 3600);
  const env2 = Object.assign({}, env, { DAO_RATE_LIMIT_MIRROR: path.join(blocker, "sub", "fired.log") });
  const r2 = spawnSync(process.execPath, [REAL_HOOK], { input: JSON.stringify(payloadOf()), encoding: "utf8", env: env2 });
  check("负控：两个域一起坏 → 仍 exit 0（镜像写不成一律吞掉）", r2.status === 0);
  {
    const ANCHOR = "  mirrorRecord(rec);";
    const h = mutantHook("nomirror", ANCHOR, "  if (false) mirrorRecord(rec);");
    const envM = Object.assign({}, env, {
      DAO_RATE_LIMIT_MIRROR: path.join(BASE, "nomirror-mirror", "fired.log"),
      DAO_RATE_LIMIT_STATE_SUBDIR: path.posix.join(TAG, "nomirror", "state"),
      DAO_RATE_LIMIT_MARKER: path.join(BASE, "nomirror", "rate-limit-interrupt.json"),
    });
    const rm = spawnSync(process.execPath, [h], { input: JSON.stringify(payloadOf()), encoding: "utf8", env: envM });
    check("先破再验：镜像调用架空 ⇒ 镜像域零记录；canary：标记照写、fired.log 照记",
      !fs.existsSync(path.join(BASE, "nomirror-mirror", "fired.log")) && rm.status === 0 &&
      fs.existsSync(path.join(BASE, "nomirror", "rate-limit-interrupt.json")) && firedLines("nomirror", h).length === 1);
  }
}
{
  // 外层 catch 相位：=outer 走外层（stderr 说未捕获异常）、=no-such-phase 不注入、=1 撞 parse
  const out = (env0) => spawnSync(process.execPath, [REAL_HOOK], { input: JSON.stringify(payloadOf()), encoding: "utf8", env: Object.assign(envFor("outer"), env0) });
  check("=outer → exit 0、stderr 说未捕获异常、写 errors.log 不写标记（外层锚不再真空）",
    (() => { const env = envFor("outerthrow"); env.DAO_RATE_LIMIT_FORCE_ERROR = "outer";
      const r = spawnSync(process.execPath, [REAL_HOOK], { input: JSON.stringify(payloadOf()), encoding: "utf8", env });
      return r.status === 0 && /未捕获异常/.test(r.stderr || "") && fs.existsSync(errorsPath("outerthrow")) && !fs.existsSync(markerPath("outerthrow")); })());
  check("=no-such-phase → 照常写标记；=1 → 撞 parse（说解析失败）",
    (() => { const e2 = envFor("pm"); e2.DAO_RATE_LIMIT_FORCE_ERROR = "no-such-phase";
      const r2 = spawnSync(process.execPath, [REAL_HOOK], { input: JSON.stringify(payloadOf()), encoding: "utf8", env: e2 });
      const e3 = envFor("p1"); e3.DAO_RATE_LIMIT_FORCE_ERROR = "1";
      const r3 = spawnSync(process.execPath, [REAL_HOOK], { input: JSON.stringify(payloadOf()), encoding: "utf8", env: e3 });
      return r2.status === 0 && fs.existsSync(markerPath("pm")) && r3.status === 0 && /解析 stdin 失败/.test(r3.stderr || ""); })());
  {
    const ANCHOR = '      const msg = `[dao-rate-limit-sentinel] 未捕获异常：${e && e.message}`;';
    const h = mutantHook("outer-failclosed", ANCHOR, ANCHOR + " process.exit(1);");
    const envM = envFor("outer-mut"); envM.DAO_RATE_LIMIT_FORCE_ERROR = "outer";
    const rm = spawnSync(process.execPath, [h], { input: JSON.stringify(payloadOf()), encoding: "utf8", env: envM });
    check("先破再验：外层 catch 改 exit 1 ⇒ 翻面（真空锚检验）；canary：正常输入照写标记",
      rm.status === 1 && (spawnSync(process.execPath, [h], { input: JSON.stringify(payloadOf()), encoding: "utf8", env: envFor("outer-canary") }).status === 0) &&
      fs.existsSync(markerPath("outer-canary")));
  }
}
{
  // #201：mirrorRecord 吞 vs 不吞可分（只坏镜像域，比对 stderr/errors.log/stdout）
  const mirrorBlocker = path.join(BASE, "mirroronly-blocker");
  fs.writeFileSync(mirrorBlocker, "占住镜像域的父路径", "utf8");
  const env = Object.assign({}, process.env, {
    DAO_RATE_LIMIT_MARKER: path.join(BASE, "mirroronly", "rate-limit-interrupt.json"),
    DAO_RATE_LIMIT_STATE_SUBDIR: path.posix.join(TAG, "mirroronly", "state"),
    DAO_RATE_LIMIT_MIRROR: path.join(mirrorBlocker, "sub", "fired.log"),
  });
  const payload = payloadOf({ last_assistant_message: "API Error: Rate limit reached · 约 1 小时后重置" });
  const r = spawnSync(process.execPath, [REAL_HOOK], { input: JSON.stringify(payload), encoding: "utf8", env });
  check("现状·吞：exit 0、主域正常、stderr 无未捕获、errors.log 不存在（镜像失败不单独留痕）",
    r.status === 0 && fs.existsSync(markerPath("mirroronly")) && firedLines("mirroronly").length === 1 &&
    !/未捕获异常/.test(r.stderr || "") && !fs.existsSync(errorsPath("mirroronly")));
  const ANCHOR = "  } catch (_) { /* 镜像写不成不该拖垮主路径 —— `_tmp` 那侧照写 */ }";
  const h = mutantHook("mirror-not-swallowed", ANCHOR, "  } catch (_) { throw _; }");
  const tagM = "mirroronly-mut";
  const envM = Object.assign({}, env, {
    DAO_RATE_LIMIT_MARKER: path.join(BASE, tagM, "rate-limit-interrupt.json"),
    DAO_RATE_LIMIT_STATE_SUBDIR: path.posix.join(TAG, tagM, "state"),
  });
  const rm = spawnSync(process.execPath, [h], { input: JSON.stringify(payload), encoding: "utf8", env: envM });
  check("先破再验：不吞 ⇒ stderr 有未捕获、errors.log 有一条、stdout 无 systemMessage（单看退出码分不出两态）",
    rm.status === 0 && /未捕获异常/.test(rm.stderr || "") &&
    fs.existsSync(errorsPath(tagM, h)) && /未捕获异常/.test(fs.readFileSync(errorsPath(tagM, h), "utf8")) &&
    (rm.stdout || "") === "");
}

console.log("\n=== --selfcheck 形态 + canary 恒等 ===");
{
  const r = spawnSync(process.execPath, [REAL_HOOK, "--selfcheck"], { input: "", encoding: "utf8", env: envFor("selfcheck") });
  check("--selfcheck 退出码 ∈ {0,1}（不是崩溃码）+ 打印带 hook 名的报头",
    (r.status === 0 || r.status === 1) && /dao-rate-limit-sentinel --selfcheck/.test(r.stdout || ""));
  check("canary 恒等：整个 mutation 过程真文件逐字节没动过",
    crypto.createHash("sha256").update(fs.readFileSync(REAL_HOOK, "utf8")).digest("hex") === SHA_BEFORE);
}

try { fs.rmSync(BASE, { recursive: true, force: true }); } catch (_) {}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
