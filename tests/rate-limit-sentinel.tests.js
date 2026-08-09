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
    // 🔴 **镜像域也必须指进沙箱**（issue #190 第 2 条新增的那条通道）：它的生产落点在
    // `~/.claude/dao-state/…`，而那份是「真实限流实战样本」的耐久数据（#190 第 1 条的重开条件
    // 直接指着这类样本）。不覆写 ⇒ 每跑一次测试就往它掺一批合成记录，把将来那次复盘的结论污染掉。
    DAO_RATE_LIMIT_MIRROR: mirrorPath(tag),
  });
}
function markerPath(tag) { return path.join(BASE, tag, "rate-limit-interrupt.json"); }
function mirrorPath(tag) { return path.join(BASE, tag, "mirror", "fired.log"); }
function mirrorLines(tag) {
  try {
    return fs.readFileSync(mirrorPath(tag), "utf8").split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}
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
// 直接往 fired.log 里塞种子记录（不经过 hook 本体）——deaths_24h 的多组边界测试
// （笔①、issue #236 挂账①②③）都要这个前置，提到模块级只留一份，不逐块各抄一份。
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

// ── mutation 沙箱（**提到模块级**，issue #190）────────────────────────────────
// 原先它住在文件末尾那个 mutation 块里，于是新增的几节（外层 catch / covers 判定 / 镜像通道）
// 各自要么再抄一份、要么就没有先破再验那一半。**同型的东西只留一个出口**——这与
// `hard-gates.tests.js` 把喂 nudge 的出口收成一个是同一条教训（同一文件里两份同型写法，
// 下一次收口必然只改到其中一份）。
const SRC = fs.readFileSync(REAL_HOOK, "utf8");
const SHA_BEFORE = crypto.createHash("sha256").update(SRC).digest("hex");
// 依赖清单从源码扫出来，不手写——手写的清单会在有人加一个 require 的那天悄悄过期，
// 而症状是「测试仍在跑，测的是个残废」。
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

console.log("\n=== 正态 · rate_limit：写标记 + 记日志 ===");
{
  const tag = "rate";
  const r = run(REAL_HOOK, payloadOf({ last_assistant_message: "API Error: Rate limit reached · 约 3 小时 12 分钟后重置" }), tag);
  check("exit 0（本事件退出码被宿主忽略，但仍不许非 0）", r.code === 0, "code=" + r.code);
  const m = readJson(markerPath(tag));
  check("标记文件已写出且是合法 JSON", m !== null);
  // 🔴 **断言名实不符已订正（issue #190 第 4 条）**：~~原名写「字段齐全…那五格」而实写 8 格~~
  //    —— 标记实际有 8 个字段，这条只查 5 个，`reset_parse` / `reset_estimate_at` / `signature`
  //    **三格无人查**；其中 `reset_estimate_at` 是**算出来的值**，最需要有人盯着（另两格
  //    `reset_parse` 由下面单独一条查、`signature` 此前彻底真空）。现在逐格点名、逐格给值。
  //    **别把它读成「字段名对不对」**：名字对而值算错（比如 `reset_estimate_at` 恒 null）
  //    是这一格真正的失效形态，故三条里有两条是值断言。
  // 🔴 **2026-08-09 issue #70 自适应并发批，笔①追加第 9 格 `deaths_24h`**：字段清单与下面
  //    「9 个字段」这句同批改，别只改数字不改名字（那正是本节自己讲的「名实不符」）。
  const FIELDS = ["at", "error", "reset_estimate_s", "reset_parse", "reset_estimate_at",
    "raw", "session_id", "signature", "deaths_24h"];
  check("标记 9 个字段一格不少（逐格点名：" + FIELDS.join(" / ") + "）",
    m && FIELDS.every((k) => Object.prototype.hasOwnProperty.call(m, k)),
    "缺=" + JSON.stringify(m ? FIELDS.filter((k) => !Object.prototype.hasOwnProperty.call(m, k)) : FIELDS));
  check("承重字段的值都对（error / raw / session_id / signature，不只是「键在」）",
    m && m.error === "rate_limit" && typeof m.raw === "string" &&
    m.session_id === "sid-" + TAG && m.signature === "[dao-rate-limit-sentinel v1]",
    "marker=" + JSON.stringify(m));
  // `reset_estimate_at` 的值断言：它 = at + reset_estimate_s（两次 Date.now() 之间有毫秒级漂移，
  // 故给 5 秒容差）。**这一格此前零守护** —— 恒 null / 算成过去时刻都不会有任何断言变红。
  check("reset_estimate_at = at + reset_estimate_s（±5s 容差；此前这一格是真空的）",
    m && typeof m.reset_estimate_at === "string" &&
    Math.abs((Date.parse(m.reset_estimate_at) - Date.parse(m.at)) - m.reset_estimate_s * 1000) <= 5000,
    "at=" + (m && m.at) + " at+=" + (m && m.reset_estimate_at) + " s=" + (m && m.reset_estimate_s));
  check("中文拼车式解析出 3 小时 12 分钟 = 11520 秒", m && m.reset_estimate_s === 11520, "得 " + (m && m.reset_estimate_s));
  check("reset_parse 记下是哪一式命中（真实语料攒够后才判得出英文式有没有用）",
    m && m.reset_parse === "cn-carpool", "得 " + (m && m.reset_parse));
  check("raw 摘录同时含 error_details 与 last_assistant_message 两侧内容",
    m && /429/.test(m.raw) && /Rate limit reached/.test(m.raw), "raw=" + (m && m.raw));
  check("deaths_24h = 1（这个 tag 的 fired.log 此前是空的，含本次死亡）",
    m && m.deaths_24h === 1, "得 " + (m && m.deaths_24h));
  const f = firedLines(tag);
  check("fired.log 记一行且 marked=true", f.length === 1 && f[0].marked === true, "fired=" + JSON.stringify(f));
  const mir = mirrorLines(tag);
  check("镜像域也记一行（#190 第 2 条：第二个物理落点，出 `_tmp` 域）",
    mir.length === 1 && mir[0].marked === true, "mirror=" + JSON.stringify(mir));
  check("镜像那份带 mirror:true（读的人要分得出自己在看哪一份）", mir[0] && mir[0].mirror === true);
  check("镜像与主账逐字段同源（除 mirror 标记外）",
    mir[0] && f[0] && mir[0].at === f[0].at && mir[0].error === f[0].error &&
    mir[0].reset_estimate_s === f[0].reset_estimate_s,
    "mirror=" + JSON.stringify(mir[0]) + " fired=" + JSON.stringify(f[0]));
}

console.log("\n=== 笔①（issue #70 自适应并发）：deaths_24h 只数「窗内 + marked:true」===");
{
  // 前置：直接往 fired.log 里塞两条**不该被计入**的记录——
  //   ① 25h 前的 marked:true（窗外，即便是死亡也不算「最近」）
  //   ② 1h 前的 marked:false（窗内，但不是死亡，只是「记了账但没写标记」的普通报错）
  // 跑一次真实死亡后，deaths_24h 应该恰好是 1（只有这次），证明两条负控各自被判据挡住。
  // （`seedFiredLog` 已提到模块级，本块起复用同一份——见上方定义处的理由）
  const OLD_MARKED = { at: new Date(Date.now() - 25 * 3600 * 1000).toISOString(), marked: true, error: "rate_limit" };
  const RECENT_UNMARKED = { at: new Date(Date.now() - 1 * 3600 * 1000).toISOString(), marked: false, error: "server_error" };

  const tag = "deaths-window";
  seedFiredLog(tag, REAL_HOOK, [OLD_MARKED, RECENT_UNMARKED]);
  run(REAL_HOOK, payloadOf(), tag);
  const m = readJson(markerPath(tag));
  check("窗外的死亡 + 窗内的非死亡都不计入 ⇒ deaths_24h = 1（只有这次）",
    m && m.deaths_24h === 1, "得 " + (m && m.deaths_24h) + "（种子=" + JSON.stringify([OLD_MARKED, RECENT_UNMARKED]) + "）");
  check("fired.log 此刻共 3 行（2 条种子 + 这次真实死亡），deaths_24h 没有把种子行数直接抄过来",
    firedLines(tag).length === 3, "fired=" + JSON.stringify(firedLines(tag)));

  // ── 先破再验：把窗口判据（`t >= cutoff`）架空 ⇒ 上面「窗外死亡不计入」那条断言必须翻面 ──
  // 形态是「结果不被消费」：`Number.isFinite(t)` 判据保留（`marked:false` 那条仍被挡），
  // 只有窗口这一半被掐掉——这样能证明这条断言真的在盯着「窗口」而不是别的什么。
  {
    const ANCHOR = "        if (Number.isFinite(t) && t >= cutoff && t <= nowMs + CLOCK_SKEW_TOLERANCE_MS) n++;";
    const h = mutantHook("deaths-window-blind", ANCHOR, "        if (Number.isFinite(t)) n++;");
    const tagM = "deaths-window-mut";
    seedFiredLog(tagM, h, [OLD_MARKED, RECENT_UNMARKED]);
    const envM = Object.assign({}, envFor(tagM));
    const rm = spawnSync(process.execPath, [h], { input: JSON.stringify(payloadOf()), encoding: "utf8", env: envM });
    const mm = readJson(markerPath(tagM));
    check("🔴 先破再验：窗口判据被架空 ⇒ 25h 前的死亡也被计进来，deaths_24h 变成 2（本次 + 那条窗外死亡）",
      mm && mm.deaths_24h === 2, "code=" + rm.status + " 得 " + (mm && mm.deaths_24h));
    check("canary：变异体还活着（marker 照写、其余字段照对，只有 deaths_24h 这一格失守）",
      mm !== null && mm.error === "rate_limit" && typeof mm.raw === "string");
    check("误伤反例：`marked:false` 那条负控在 mutation 后仍被挡住（架空的只是窗口，不是 marked 过滤）",
      mm && mm.deaths_24h === 2, "若 marked:false 也被误计，这里会 >2：得 " + (mm && mm.deaths_24h));
  }

  // ── M5' 零守护断言（2026-08-09，PR #230 对抗返修）───────────────────────────
  // 头注旗舰宣称「读失败记 null 不记 0」此前**没有任何断言在守**：对抗官把 catch 里的
  // `return null` 改成 `return 0`，既有 165 条断言零反对。补两条：①正态证明这一格此前
  // 唯一成立的场景（`readFileSync` 真抛异常，例如 fired.log 路径被占成目录）确实得 null；
  // ②先破再验，把那个 mutation 真的跑一遍，证明①的断言真的在盯着这件事。
  console.log("\n=== M5' 零守护断言：fired.log 路径被占成目录 ⇒ readFileSync 真抛 ⇒ deaths_24h = null ===");
  {
    const tag = "deaths-dir-occupied";
    // 直接把 fired.log 那个路径本身建成目录——readJsonlRecords 内部的 `fs.existsSync` 会判真
    // （目录也是"存在"），随后 `fs.readFileSync` 对目录操作在本机实测抛 EISDIR（先手工验证过，
    // 见对抗官证据表 P5），走的正是 countDeaths24h 外层 try/catch 那条路，不是 parseJsonl 内部
    // 逐行吞掉的那条路——两条路径必须分得开，这正是本条要证的事。
    fs.mkdirSync(firedPath(tag, REAL_HOOK), { recursive: true });
    run(REAL_HOOK, payloadOf(), tag);
    const m = readJson(markerPath(tag));
    check("fired.log 路径被占成目录 ⇒ readFileSync 真抛 ⇒ deaths_24h = null（不是 0，不是留空）",
      m && Object.prototype.hasOwnProperty.call(m, "deaths_24h") && m.deaths_24h === null,
      "marker=" + JSON.stringify(m));

    const ANCHOR = "    return null;";
    const h = mutantHook("null-vs-zero", ANCHOR, "    return 0;");
    const tagM = "deaths-dir-occupied-mut";
    fs.mkdirSync(firedPath(tagM, h), { recursive: true });
    const rm = spawnSync(process.execPath, [h], { input: JSON.stringify(payloadOf()), encoding: "utf8", env: envFor(tagM) });
    const mm = readJson(markerPath(tagM));
    check("🔴 先破再验：`return null` 改成 `return 0`（M5'，正是宣称禁止的那件事）⇒ 同一份"
      + "「目录占位」场景下 deaths_24h 从 null 翻成 1（本次死亡的 +1）",
      mm && mm.deaths_24h === 1, "code=" + rm.status + " 得 " + JSON.stringify(mm && mm.deaths_24h));
    check("canary：变异体还活着（marker 照写、其余字段照对，只有 deaths_24h 这一格失守）",
      mm !== null && mm.error === "rate_limit" && typeof mm.raw === "string", "marker=" + JSON.stringify(mm));
  }
}

console.log("\n=== issue #236 挂账①：未来时间戳不得永久计入（deaths_24h 上界）===");
{
  // 伪造一条「未来」的 marked:true 死亡（at = 现在 + 10 天）。修上界之前它会被永久计入
  // （issue #236 对抗证据 P7/P8：+10 天与 9999 年都被计进去，且永不过期）；
  // 修上界之后它应该像窗外记录一样被挡住。
  const FUTURE_MARKED = { at: new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString(), marked: true, error: "rate_limit" };

  const tag = "deaths-future";
  seedFiredLog(tag, REAL_HOOK, [FUTURE_MARKED]);
  run(REAL_HOOK, payloadOf(), tag);
  const m = readJson(markerPath(tag));
  check("未来 10 天的 marked:true 不计入 ⇒ deaths_24h = 1（只有这次真实死亡）",
    m && m.deaths_24h === 1, "得 " + (m && m.deaths_24h) + "（种子=" + JSON.stringify([FUTURE_MARKED]) + "）");

  // 先破再验：只撤掉新增的上界（`&& t <= nowMs`），下界 `t >= cutoff` 原样保留——
  // 证明这条正控真的在盯着"上界"，不是靠上面「架空整段窗口」那条 mutation 顺带盖住的。
  {
    const ANCHOR = "        if (Number.isFinite(t) && t >= cutoff && t <= nowMs + CLOCK_SKEW_TOLERANCE_MS) n++;";
    const h = mutantHook("deaths-future-nocap", ANCHOR, "        if (Number.isFinite(t) && t >= cutoff) n++;");
    const tagM = "deaths-future-mut";
    seedFiredLog(tagM, h, [FUTURE_MARKED]);
    const rm = spawnSync(process.execPath, [h], { input: JSON.stringify(payloadOf()), encoding: "utf8", env: envFor(tagM) });
    const mm = readJson(markerPath(tagM));
    check("🔴 先破再验：撤掉上界 ⇒ 未来 10 天的死亡也被计入，deaths_24h 变成 2（issue #236 P7/P8 原始症状复现）",
      mm && mm.deaths_24h === 2, "code=" + rm.status + " 得 " + (mm && mm.deaths_24h));
    check("canary：变异体还活着（marker 照写、其余字段照对，只有 deaths_24h 这一格失守）",
      mm !== null && mm.error === "rate_limit" && typeof mm.raw === "string");
  }
}

console.log("\n=== issue #243②：时钟回拨容差 5 分钟 —— 容差内的「轻度未来」记录计入 ===");
{
  // 出处：用户 2026-08-09 拍板（issue #70 评论 5231799900）——issue #236①原始零容差修法下，
  // 墙钟回拨 ≥1ms 起窗口内真实死亡记录即从计数消失（issue #243②实测：2s/30s/5min/1h 四格
  // 全被排除）。5 分钟容差吸收 NTP 校时抖动，容差内的「未来」记录不再被误判为伪造而排除。
  const NEAR_FUTURE_MARKED = { at: new Date(Date.now() + 3 * 60 * 1000).toISOString(), marked: true, error: "rate_limit" };

  const tag = "deaths-clock-skew-within";
  seedFiredLog(tag, REAL_HOOK, [NEAR_FUTURE_MARKED]);
  run(REAL_HOOK, payloadOf(), tag);
  const m = readJson(markerPath(tag));
  check("容差内（+3 分钟）的未来记录计入 ⇒ deaths_24h = 2（那条 + 这次真实死亡）",
    m && m.deaths_24h === 2, "得 " + (m && m.deaths_24h) + "（种子=" + JSON.stringify([NEAR_FUTURE_MARKED]) + "）");

  // 先破再验：把容差从 5 分钟收紧回 0（issue #236①原状）⇒ 上面那条正控必须翻面——
  // 证明它真的在盯着容差本身，不是碰巧对。
  {
    const ANCHOR = "        if (Number.isFinite(t) && t >= cutoff && t <= nowMs + CLOCK_SKEW_TOLERANCE_MS) n++;";
    const h = mutantHook("clock-skew-zeroed", ANCHOR, "        if (Number.isFinite(t) && t >= cutoff && t <= nowMs) n++;");
    const tagM = "deaths-clock-skew-within-mut";
    seedFiredLog(tagM, h, [NEAR_FUTURE_MARKED]);
    const rm = spawnSync(process.execPath, [h], { input: JSON.stringify(payloadOf()), encoding: "utf8", env: envFor(tagM) });
    const mm = readJson(markerPath(tagM));
    check("🔴 先破再验：容差收紧回 0 ⇒ +3 分钟的记录被排除，deaths_24h 从 2 变成 1（issue #243②原始症状复现）",
      mm && mm.deaths_24h === 1, "code=" + rm.status + " 得 " + (mm && mm.deaths_24h));
    check("canary：变异体还活着（marker 照写、其余字段照对，只有 deaths_24h 这一格失守）",
      mm !== null && mm.error === "rate_limit" && typeof mm.raw === "string");
  }
}

console.log("\n=== issue #243②：容差之外（+10 分钟）的未来记录仍被排除（防伪造）===");
{
  // 与上一节互为镜像：容差不是「取消上界」，超过 5 分钟的未来时间戳依旧判为伪造而排除
  // （零容差版本已排除，这里额外证明「加了容差」没有连带把上界本身撤掉）。
  const BEYOND_TOLERANCE_MARKED = { at: new Date(Date.now() + 10 * 60 * 1000).toISOString(), marked: true, error: "rate_limit" };

  const tag = "deaths-clock-skew-beyond";
  seedFiredLog(tag, REAL_HOOK, [BEYOND_TOLERANCE_MARKED]);
  run(REAL_HOOK, payloadOf(), tag);
  const m = readJson(markerPath(tag));
  check("超出容差（+10 分钟）的未来记录不计入 ⇒ deaths_24h = 1（只有这次真实死亡）",
    m && m.deaths_24h === 1, "得 " + (m && m.deaths_24h) + "（种子=" + JSON.stringify([BEYOND_TOLERANCE_MARKED]) + "）");

  // 先破再验：把容差从 5 分钟放宽到「撤掉上界」⇒ 上面那条负控必须翻面——
  // 证明它真的在盯着容差是有限的，不是碰巧对。
  {
    const ANCHOR = "        if (Number.isFinite(t) && t >= cutoff && t <= nowMs + CLOCK_SKEW_TOLERANCE_MS) n++;";
    const h = mutantHook("clock-skew-unbounded", ANCHOR, "        if (Number.isFinite(t) && t >= cutoff) n++;");
    const tagM = "deaths-clock-skew-beyond-mut";
    seedFiredLog(tagM, h, [BEYOND_TOLERANCE_MARKED]);
    const rm = spawnSync(process.execPath, [h], { input: JSON.stringify(payloadOf()), encoding: "utf8", env: envFor(tagM) });
    const mm = readJson(markerPath(tagM));
    check("🔴 先破再验：撤掉上界 ⇒ +10 分钟的记录也被计入，deaths_24h 从 1 变成 2",
      mm && mm.deaths_24h === 2, "code=" + rm.status + " 得 " + (mm && mm.deaths_24h));
    check("canary：变异体还活着（marker 照写、其余字段照对，只有 deaths_24h 这一格失守）",
      mm !== null && mm.error === "rate_limit" && typeof mm.raw === "string");
  }
}

console.log("\n=== issue #236 挂账②：窗口收紧方向要有测试兜底（23h 正控）===");
{
  // 既有语料只覆盖到 1h 以内（正控）与 25h（窗外负控），窗口在 0~25h 之间随便改都测不出来
  // （issue #236 M9/M14：24h→1分钟、24h→23h 均 0 条红）。补一条 23h 正控：把窗口从 24h
  // 意外收紧到更短时，这条记录会从「计入」翻成「不计入」，正是本条要抓的方向。
  const D23H_MARKED = { at: new Date(Date.now() - 23 * 3600 * 1000).toISOString(), marked: true, error: "rate_limit" };

  const tag = "deaths-23h";
  seedFiredLog(tag, REAL_HOOK, [D23H_MARKED]);
  run(REAL_HOOK, payloadOf(), tag);
  const m = readJson(markerPath(tag));
  check("23 小时前的 marked:true 仍应计入 ⇒ deaths_24h = 2（那条 + 这次真实死亡）",
    m && m.deaths_24h === 2, "得 " + (m && m.deaths_24h) + "（种子=" + JSON.stringify([D23H_MARKED]) + "）");

  // 先破再验：把窗口从 24h 收紧到 1h（issue #236 M9 的具体形态之一）⇒ 23h 前那条应该
  // 从"计入"翻成"不计入"，证明上面那条正控真的在盯着窗口长度，不是碰巧对。
  {
    const ANCHOR = "const DEATHS_WINDOW_MS = 24 * 3600 * 1000;";
    const h = mutantHook("deaths-window-shrink", ANCHOR, "const DEATHS_WINDOW_MS = 1 * 3600 * 1000;");
    const tagM = "deaths-23h-mut";
    seedFiredLog(tagM, h, [D23H_MARKED]);
    const rm = spawnSync(process.execPath, [h], { input: JSON.stringify(payloadOf()), encoding: "utf8", env: envFor(tagM) });
    const mm = readJson(markerPath(tagM));
    check("🔴 先破再验：窗口收紧到 1h ⇒ 23h 前那条掉出窗口，deaths_24h 从 2 变成 1（只剩这次死亡）",
      mm && mm.deaths_24h === 1, "code=" + rm.status + " 得 " + (mm && mm.deaths_24h));
    check("canary：变异体还活着（marker 照写、其余字段照对，只有 deaths_24h 这一格失守）",
      mm !== null && mm.error === "rate_limit" && typeof mm.raw === "string");
  }
}

console.log("\n=== issue #236 挂账③：死亡判定不能从 `=== true` 松成 truthy ===");
{
  // 写入侧目前永远是布尔值，故这不是当前活跃风险，而是**结构上**没有断言在守
  // （issue #236 M7：`marked === true` 松成 `marked`，既有 165 条断言零反对）。
  // 补一条正控：一个 truthy 但非严格 true 的值不应被计入。
  // 🔴 **样本订正（issue #243①，出处 PR #239 判词）**：此前样本是字符串 "true"，
  // 而 `"true" == true` 恰为 false（字符串走 Number() 强转成 NaN，NaN == 1 恒 false）
  // ⇒ `=== true` 松成 `== true`（宽松相等）这一放宽形态从射程外溜走，对抗官实测零守护。
  // 换成数字 1：`1` 既 truthy 又 `1 == true`，一个样本同钉 truthy 与宽松相等两种放宽形态。
  const TRUTHY_NOT_TRUE = { at: new Date(Date.now() - 1 * 3600 * 1000).toISOString(), marked: 1, error: "rate_limit" };

  const tag = "deaths-marked-truthy";
  seedFiredLog(tag, REAL_HOOK, [TRUTHY_NOT_TRUE]);
  run(REAL_HOOK, payloadOf(), tag);
  const m = readJson(markerPath(tag));
  check("marked:1（truthy 且 1 == true，但非严格 true）不计入 ⇒ deaths_24h = 1（只有这次真实死亡）",
    m && m.deaths_24h === 1, "得 " + (m && m.deaths_24h) + "（种子=" + JSON.stringify([TRUTHY_NOT_TRUE]) + "）");

  // 先破再验：把 `=== true` 松成 truthy 判据 ⇒ 上面那条记录翻面被计入。
  {
    const ANCHOR = "      if (r && r.marked === true) {";
    const h = mutantHook("deaths-marked-loosen", ANCHOR, "      if (r && r.marked) {");
    const tagM = "deaths-marked-truthy-mut";
    seedFiredLog(tagM, h, [TRUTHY_NOT_TRUE]);
    const rm = spawnSync(process.execPath, [h], { input: JSON.stringify(payloadOf()), encoding: "utf8", env: envFor(tagM) });
    const mm = readJson(markerPath(tagM));
    check("🔴 先破再验：`=== true` 松成 truthy ⇒ marked:1 那条被计入，deaths_24h 从 1 变成 2",
      mm && mm.deaths_24h === 2, "code=" + rm.status + " 得 " + (mm && mm.deaths_24h));
    check("canary：变异体还活着（marker 照写、其余字段照对，只有 deaths_24h 这一格失守）",
      mm !== null && mm.error === "rate_limit" && typeof mm.raw === "string");
  }
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
  // ── M7（issue #217，出处 PR #212 对抗评论）─────────────────────────────────
  // `mirrorRecord()` 的生产调用点有 2 个：主路径（下面「正态」那几节都在测）与
  // 坏 stdin 这条路（`main()` 里 `mirrorRecord(badRec)`）。此前只有第 1 个被端到端覆盖——
  // 删掉第 2 个调用点，156 条断言一条不红。这里补上。
  const mir = mirrorLines(tag);
  check("🔴 坏 stdin → 镜像域也记一行（M7：mirrorRecord 第 2 个调用点，此前零覆盖）",
    mir.length === 1 && mir[0].synthetic === true && mir[0].marked === false && mir[0].error === null,
    "mirror=" + JSON.stringify(mir));

  // ── 先破再验：把这个调用点架空 ⇒ 上面那条镜像断言必须翻面 ──────────────────────
  const ANCHOR = "    mirrorRecord(badRec);";
  const h = mutantHook("badpath-no-mirror", ANCHOR, "    if (false) mirrorRecord(badRec);");
  const tagM = "badjson-mut";
  const rm = run(h, null, tagM, "这不是 JSON{{{");
  check("canary：变异体还活着（errors.log 照写、exit 0 照旧——坏的只有镜像这一格）",
    rm.code === 0 && fs.existsSync(errorsPath(tagM, h)), "code=" + rm.code);
  check("🔴 先破再验：坏 stdin 路径的镜像调用被架空 ⇒ 镜像域零记录（M7 断言不是摆设）",
    mirrorLines(tagM).length === 0, "mirror=" + JSON.stringify(mirrorLines(tagM)));
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
  check("deaths_24h 从 1 累计到 2（同一 tag 连续两次死亡，标记覆盖但死亡计数不覆盖）",
    first && first.deaths_24h === 1 && second && second.deaths_24h === 2,
    "first=" + (first && first.deaths_24h) + " second=" + (second && second.deaths_24h));
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

console.log("\n=== 留痕单点加固（#190 第 2 条）：主域坏掉时镜像照记 ===");
{
  // 这一节复刻对抗官 2026-08-08 的实测：把留痕主域**弄坏**（父路径占成普通文件 ⇒ `mkdirSync`
  // 抛 ENOTDIR/EEXIST ⇒ heartbeat 与 appendErrorLog 双双吞掉），看这次限流还剩几条通道。
  // 加固前的答案是**零条**（四条通道全哑、exit 0，与「本次没限流」逐字节相同）。
  const blocker = path.join(BASE, "brokenstate");
  fs.writeFileSync(blocker, "我是一个普通文件，不是目录", "utf8");   // 把主域的父路径占掉
  const tag = "brokenstate/state";
  const env = Object.assign({}, process.env, {
    DAO_RATE_LIMIT_MARKER: path.join(BASE, "brokenmarker", "rate-limit-interrupt.json"),
    DAO_RATE_LIMIT_STATE_SUBDIR: path.posix.join(TAG, tag),
    DAO_RATE_LIMIT_MIRROR: path.join(BASE, "brokenstate-mirror", "fired.log"),
  });
  const r = spawnSync(process.execPath, [REAL_HOOK], {
    input: JSON.stringify(payloadOf({ last_assistant_message: "API Error: Rate limit reached · 约 1 小时后重置" })),
    encoding: "utf8", env,
  });
  const brokenFired = path.join(REPO, "_tmp", TAG, tag, "fired.log");
  const brokenErrors = path.join(REPO, "_tmp", TAG, tag, "errors.log");
  const mir = (() => {
    try {
      return fs.readFileSync(path.join(BASE, "brokenstate-mirror", "fired.log"), "utf8")
        .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    } catch (_) { return []; }
  })();
  check("主域坏掉 → 仍 exit 0（fail-open 不变）", r.status === 0, "code=" + r.status);
  check("前提：主域真的坏了（fired.log / errors.log 两样都写不出来）—— 这一条是本节的靶还活着的证明",
    !fs.existsSync(brokenFired) && !fs.existsSync(brokenErrors),
    "fired存在=" + fs.existsSync(brokenFired) + " errors存在=" + fs.existsSync(brokenErrors));
  check("🔴 镜像域照记一行 ⇒ 这次限流没有静默消失（加固前这里是 0 条）",
    mir.length === 1 && mir[0].error === "rate_limit" && mir[0].mirror === true,
    "mirror=" + JSON.stringify(mir));
  check("镜像那条带得出重置估时（承重字段没被降级成只剩个时间戳）",
    mir[0] && mir[0].reset_estimate_s === 3600, "mirror=" + JSON.stringify(mir[0]));
  // 负控：镜像**也**坏掉时不许炸 —— 它是冗余通道，写不成只能吞
  const env2 = Object.assign({}, env, { DAO_RATE_LIMIT_MIRROR: path.join(blocker, "sub", "fired.log") });
  const r2 = spawnSync(process.execPath, [REAL_HOOK], {
    input: JSON.stringify(payloadOf()), encoding: "utf8", env: env2,
  });
  check("负控：两个域一起坏 → 仍 exit 0（镜像写不成一律吞掉，绝不拖垮主路径）",
    r2.status === 0, "code=" + r2.status);

  // ── 先破再验（就近放）：把镜像调用架空 ⇒ 上面那条「镜像域照记一行」必须变红 ────────
  // 形态选的是「**保留字面但使其不执行**」而不是整段删除：删掉 code review 一眼看得见，
  // 「留着但永远不执行」才骗得过人眼，而那正是 `[#官抗-改坏多形态]` 的第②向。
  {
    const ANCHOR = "  mirrorRecord(rec);";
    const h = mutantHook("nomirror", ANCHOR, "  if (false) mirrorRecord(rec);");
    const envM = Object.assign({}, env, {
      DAO_RATE_LIMIT_MIRROR: path.join(BASE, "nomirror-mirror", "fired.log"),
      DAO_RATE_LIMIT_STATE_SUBDIR: path.posix.join(TAG, "nomirror", "state"),
      DAO_RATE_LIMIT_MARKER: path.join(BASE, "nomirror", "rate-limit-interrupt.json"),
    });
    const rm = spawnSync(process.execPath, [h], {
      input: JSON.stringify(payloadOf()), encoding: "utf8", env: envM,
    });
    const gone = fs.existsSync(path.join(BASE, "nomirror-mirror", "fired.log"));
    check("先破再验：镜像调用被架空 ⇒ 镜像域零记录（上面那组镜像断言不是摆设）",
      !gone, "镜像文件竟然还在");
    check("canary：变异体还活着（标记照写、fired.log 照记 —— 只有镜像这一格没了）",
      rm.status === 0 && fs.existsSync(path.join(BASE, "nomirror", "rate-limit-interrupt.json")) &&
      firedLines("nomirror", h).length === 1,
      "code=" + rm.status + " fired=" + JSON.stringify(firedLines("nomirror", h)));
  }
}

console.log("\n=== 外层 catch 不再是真空锚（#190 第 3 条）===");
{
  // 加固前：本文件全部故障注入点都在 `main()` 内层 try 里 ⇒ 异常**走不到**最外层 catch
  //   ⇒ 把那条路改成 fail-closed 也没有一条断言会红（真空锚）。
  // 现在 `S.maybeForceError("outer")` 住在内层 try **之外**，这一节把那条路第一次真的跑到。
  const tag = "outerthrow";
  const env = envFor(tag); env.DAO_RATE_LIMIT_FORCE_ERROR = "outer";
  const r = spawnSync(process.execPath, [REAL_HOOK], {
    input: JSON.stringify(payloadOf()), encoding: "utf8", env,
  });
  check("外层相位注入 → 仍 exit 0（本事件退出码被宿主忽略，但不许非 0 假装出事）",
    r.status === 0, "code=" + r.status);
  check("外层相位注入 → stderr 明说是未捕获异常（走的确实是最外层那条路，不是内层）",
    /未捕获异常/.test(r.stderr || ""), "err=" + String(r.stderr || "").slice(0, 160));
  check("外层相位注入 → 写 errors.log 留痕（静默是这个 hook 最坏的死法）",
    fs.existsSync(errorsPath(tag)));
  check("外层相位注入 → 不写标记（异常发生在写标记之前）", !fs.existsSync(markerPath(tag)));

  // 误伤反例：相位名对不上就不该注入 —— 否则「相位」这个机制等于没有，
  // 而 `=1` 那条历史路径（撞第一个注入点）必须一字不变。
  const tag2 = "phase-mismatch";
  const env2 = envFor(tag2); env2.DAO_RATE_LIMIT_FORCE_ERROR = "no-such-phase";
  const r2 = spawnSync(process.execPath, [REAL_HOOK], {
    input: JSON.stringify(payloadOf()), encoding: "utf8", env: env2,
  });
  check("误伤反例：相位名不匹配 → 一切照常（标记照写）⇒ 相位机制不是「设了就抛」",
    r2.status === 0 && fs.existsSync(markerPath(tag2)), "code=" + r2.status);
  const tag3 = "phase-one";
  const env3 = envFor(tag3); env3.DAO_RATE_LIMIT_FORCE_ERROR = "1";
  const r3 = spawnSync(process.execPath, [REAL_HOOK], {
    input: JSON.stringify(payloadOf()), encoding: "utf8", env: env3,
  });
  check("历史路径不变：`=1` 仍撞在 parse 相位（stderr 说的是解析失败，不是未捕获异常）",
    r3.status === 0 && /解析 stdin 失败/.test(r3.stderr || "") && !/未捕获异常/.test(r3.stderr || ""),
    "err=" + String(r3.stderr || "").slice(0, 160));

  // ── 先破再验（就近放）：把最外层 catch 改成 fail-closed ⇒ 上面那条 exit 0 断言必须变红 ──
  // 这就是「真空锚」的定义性检验：**加固之前跑这一段，红集是 0**（异常走不到外层，
  // 无论外层写什么都不影响任何断言）。现在它红得起来，才说明外层那条路真的被跑到了。
  {
    const ANCHOR = '      const msg = `[dao-rate-limit-sentinel] 未捕获异常：${e && e.message}`;';
    const h = mutantHook("outer-failclosed", ANCHOR, ANCHOR + " process.exit(1);");
    const envM = envFor("outer-mut"); envM.DAO_RATE_LIMIT_FORCE_ERROR = "outer";
    const rm = spawnSync(process.execPath, [h], {
      input: JSON.stringify(payloadOf()), encoding: "utf8", env: envM,
    });
    check("先破再验：外层 catch 改成 exit 1 ⇒ 「仍 exit 0」那条断言翻面（外层锚不再真空）",
      rm.status === 1, "code=" + rm.status + " err=" + String(rm.stderr || "").slice(0, 160));
    check("canary：变异体还活着（正常输入下照常写标记、exit 0 —— 坏的只有异常那条路）",
      (spawnSync(process.execPath, [h], {
        input: JSON.stringify(payloadOf()), encoding: "utf8", env: envFor("outer-canary"),
      }).status === 0) && fs.existsSync(markerPath("outer-canary")));
  }
}

console.log("\n=== #201 笔1：mirrorRecord 的 catch(_){} 不再是真空锚（吞 vs 不吞外层兜可区分）===");
{
  // 对抗实测（issue #201）：把 `catch (_) { ... }` 改成 `catch (_) { throw _; }` 后，
  // 既有 134 条断言零红——因为两条路径当时唯一被盯着的可观测量（exit 0、marker 照写、
  // fired.log 照记）在两态下逐字节相同，没有一条断言盯着「异常有没有被吞」这件事本身。
  // 这一节专门造这个判别力：让**只有镜像域**坏掉（主域健康），比对「吞」（现状）与
  // 「不吞、走最外层 catch」（mutation）在 stderr / errors.log / stdout 三处的差异。
  const tag = "mirroronly";
  const mirrorBlocker = path.join(BASE, "mirroronly-blocker");
  fs.writeFileSync(mirrorBlocker, "占住镜像域的父路径，只坏这一个域", "utf8");
  const env = Object.assign({}, process.env, {
    DAO_RATE_LIMIT_MARKER: path.join(BASE, tag, "rate-limit-interrupt.json"),
    DAO_RATE_LIMIT_STATE_SUBDIR: path.posix.join(TAG, tag, "state"),
    DAO_RATE_LIMIT_MIRROR: path.join(mirrorBlocker, "sub", "fired.log"),
  });
  const payload = payloadOf({ last_assistant_message: "API Error: Rate limit reached · 约 1 小时后重置" });

  // ── 现状（吞）：主域全须完好，errors.log 不该提「未捕获异常」，systemMessage 照打 ──
  const r = spawnSync(process.execPath, [REAL_HOOK], { input: JSON.stringify(payload), encoding: "utf8", env });
  check("前提：只有镜像域坏了（主域没受影响）—— mirror 目录确实写不进去",
    !fs.existsSync(path.join(mirrorBlocker, "sub")), "sub 目录竟然被建出来了");
  check("现状·吞：exit 0", r.status === 0, "code=" + r.status);
  check("现状·吞：主域正常（marker 照写、fired.log 照记）",
    fs.existsSync(markerPath(tag)) && firedLines(tag).length === 1,
    "marker存在=" + fs.existsSync(markerPath(tag)) + " fired=" + JSON.stringify(firedLines(tag)));
  check("现状·吞：stderr 不含「未捕获异常」（异常在 mirrorRecord 内部就被吞掉，没走到最外层 catch）",
    !/未捕获异常/.test(r.stderr || ""), "err=" + r.stderr);
  check("现状·吞：errors.log 不存在（镜像失败没有留痕——它压根没被 appendErrorLog 记过）",
    !fs.existsSync(errorsPath(tag)), "errors.log 竟然存在");
  check("现状·吞：stdout 仍打出本次判定的 systemMessage（main() 走完了全程，不是半路跳出）",
    /dao-rate-limit-sentinel v1/.test(r.stdout || ""), "out=" + r.stdout);

  // ── mutation：catch(_) { ... } 改成 catch(_) { throw _; } —— 让它不吞、走最外层 catch ──
  const ANCHOR = "  } catch (_) { /* 镜像写不成不该拖垮主路径 —— `_tmp` 那侧照写 */ }";
  const h = mutantHook("mirror-not-swallowed", ANCHOR, "  } catch (_) { throw _; }");
  const tagM = "mirroronly-mut";
  const envM = Object.assign({}, env, {
    DAO_RATE_LIMIT_MARKER: path.join(BASE, tagM, "rate-limit-interrupt.json"),
    DAO_RATE_LIMIT_STATE_SUBDIR: path.posix.join(TAG, tagM, "state"),
  });
  const rm = spawnSync(process.execPath, [h], { input: JSON.stringify(payload), encoding: "utf8", env: envM });
  check("🔴 mutation·不吞：exit 仍是 0（最外层 catch 也 exit 0 —— 单看退出码分不出两态，这正是 134 条零红的成因）",
    rm.status === 0, "code=" + rm.status);
  check("🔴 mutation·不吞：stderr 这次真含「未捕获异常」（异常穿过 mirrorRecord、被最外层 catch 接住）",
    /未捕获异常/.test(rm.stderr || ""), "err=" + rm.stderr);
  check("🔴 mutation·不吞：errors.log 这次真有一条记录（最外层 catch 调了 appendErrorLog）",
    fs.existsSync(errorsPath(tagM, h)) && /未捕获异常/.test(fs.readFileSync(errorsPath(tagM, h), "utf8")),
    "errors.log 内容=" + (fs.existsSync(errorsPath(tagM, h)) ? fs.readFileSync(errorsPath(tagM, h), "utf8") : "(不存在)"));
  check("🔴 mutation·不吞：stdout 这次没有 systemMessage（main() 在打印前就已经跳到最外层 catch）",
    (rm.stdout || "") === "", "out=" + JSON.stringify(rm.stdout));
  check("canary：变异体还活着（marker 与 fired.log 都在 mirrorRecord 之前写完，照样落盘）",
    fs.existsSync(markerPath(tagM)) && firedLines(tagM, h).length === 1,
    "marker存在=" + fs.existsSync(markerPath(tagM)) + " fired=" + JSON.stringify(firedLines(tagM, h)));
}

console.log("\n=== #201 笔2：镜像域结构性沙箱兜底（忘传 DAO_RATE_LIMIT_MIRROR 不再落生产路径）===");
{
  // 前情：镜像域此前只有一种隔离手段——每个测试消费方各自记得传 `DAO_RATE_LIMIT_MIRROR`。
  // 第二个消费方忘传就会把合成样本静默写进 `~/.claude/dao-state/...` 那口「真实限流实战样本」
  // 井里，且看不出是假的（对抗官在 PR #196 复核期间自己就当场踩过一次）。
  // 修法：只要 `DAO_RATE_LIMIT_MARKER` 或 `DAO_RATE_LIMIT_STATE_SUBDIR` 被显式覆写
  // （即调用方已经在把别的落盘面往沙箱里赶），哪怕漏传 MIRROR，镜像也该跟着落沙箱旁边，
  // 而不是滑回生产默认值。
  // **安全网**：即便这条判据本身有 bug 真的滑回了旧默认值，也不能让这次测试真的碰到
  // 使用者本机的 `~/.claude/dao-state`——把 USERPROFILE/HOME 一并指进沙箱假 home，
  // 让「旧默认值」在这次测试里指向一个无害的假路径，而不是真实用户目录。
  const fakeHome = path.join(BASE, "fallback-home");
  fs.mkdirSync(fakeHome, { recursive: true });
  const legacyDefaultPath = path.join(fakeHome, ".claude", "dao-state", "rate-limit-sentinel", "fired.log");

  function runWithoutMirrorEnv(hookPath, tag, extraEnv) {
    const env = Object.assign({}, process.env, {
      USERPROFILE: fakeHome, HOME: fakeHome,
      DAO_RATE_LIMIT_MARKER: path.join(BASE, tag, "rate-limit-interrupt.json"),
      DAO_RATE_LIMIT_STATE_SUBDIR: path.posix.join(TAG, tag, "state"),
    }, extraEnv || {});
    delete env.DAO_RATE_LIMIT_MIRROR; // 刻意不传——这正是要兜的那个「忘传」场景
    return spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify(payloadOf({ last_assistant_message: "API Error: Rate limit reached · 约 1 小时后重置" })),
      encoding: "utf8", env,
    });
  }

  const tag = "fallback-real";
  const r = runWithoutMirrorEnv(REAL_HOOK, tag);
  check("现状·兜底生效：exit 0", r.status === 0, "code=" + r.status);
  check("现状·兜底生效：主域正常（marker 照写、fired.log 照记，证明这次真的没漏传 MARKER/STATE_SUBDIR）",
    fs.existsSync(markerPath(tag)) && firedLines(tag).length === 1,
    "marker存在=" + fs.existsSync(markerPath(tag)) + " fired=" + JSON.stringify(firedLines(tag)));
  check("🔴 现状·兜底生效：旧生产默认路径（哪怕是假 home 下那份）没有被写入",
    !fs.existsSync(legacyDefaultPath), "legacyDefaultPath 竟然被写出：" + legacyDefaultPath);
  const fallbackPath = path.join(BASE, tag, "mirror-fallback", "fired.log");
  check("🔴 现状·兜底生效：镜像改落在 MARKER 旁边的 mirror-fallback/ 子目录里",
    fs.existsSync(fallbackPath), "期望路径不存在：" + fallbackPath);
  const fallbackLines = (() => {
    try { return fs.readFileSync(fallbackPath, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); }
    catch (_) { return []; }
  })();
  check("兜底落点里的记录内容正常（不是空文件、marked=true）",
    fallbackLines.length === 1 && fallbackLines[0].marked === true && fallbackLines[0].mirror === true,
    "fallback=" + JSON.stringify(fallbackLines));

  // ── 先破再验：把 deriveMirrorFallback 架空，直接退回旧的唯一默认值 ──────────────
  // 形态是「保留字面但使其不执行」：在函数体最前面插入一个提前 return，
  // 后面两个覆写检查与它们的 return 全部变成永远跑不到的死代码（语法仍合法，只是不再
  // 生效）——这正是本条修复前的行为，也是本节要证明「加固前会怎样」的对照组。
  const ANCHOR = "function deriveMirrorFallback() {";
  const REPLACEMENT = "function deriveMirrorFallback() {\n" +
    "  return path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), \".claude\", \"dao-state\", \"rate-limit-sentinel\", \"fired.log\"); // #201 笔2 mutation：提前 return，架空下面两个覆写检查";
  const h = mutantHook("mirror-fallback-disabled", ANCHOR, REPLACEMENT);
  const tagM = "fallback-mut";
  const rm = runWithoutMirrorEnv(h, tagM);
  check("canary：变异体还活着（marker / fired.log 照写，主域没被这次改动波及）",
    rm.status === 0 && fs.existsSync(markerPath(tagM)) && firedLines(tagM, h).length === 1,
    "code=" + rm.status);
  check("🔴 mutation·兜底被架空：这次真的写进了（假 home 下的）生产默认路径 —— 证明这条断言真的在盯着这件事",
    fs.existsSync(legacyDefaultPath), "legacyDefaultPath 仍然不存在：" + legacyDefaultPath);
}

console.log("\n=== M5（issue #217）：deriveMirrorFallback 的 STATE_SUBDIR 分支，此前零覆盖 ===");
{
  // 前情（出处 PR #212 对抗评论）：`deriveMirrorFallback` 有三条分支（MARKER / STATE_SUBDIR /
  // 生产默认值）。此前全套测试要么两个 env 都指（落分支①）、要么两个都不指（落分支③），
  // **分支②（只指 STATE_SUBDIR、不指 MARKER）从未被单独触达**——整段架空，156 条零红。
  // 安全：payload 用非限流类 error（不触发 writeMarker，MARKER_PATH 就算解到真实默认值
  // 也不会被写一个字节）；STATE_SUBDIR 沙箱化后连带把主域（fired.log/errors.log）也带
  // 进沙箱；fakeHome 是保险丝——万一分支②本身有 bug 真滑到分支③，也只碰得到假路径。
  const fakeHome = path.join(BASE, "m5-home");
  fs.mkdirSync(fakeHome, { recursive: true });
  const legacyDefaultPath = path.join(fakeHome, ".claude", "dao-state", "rate-limit-sentinel", "fired.log");

  function runStateSubdirOnly(hookPath, tag) {
    const env = Object.assign({}, process.env, {
      USERPROFILE: fakeHome, HOME: fakeHome,
      DAO_RATE_LIMIT_STATE_SUBDIR: path.posix.join(TAG, tag, "state"),
    });
    delete env.DAO_RATE_LIMIT_MARKER;
    delete env.DAO_RATE_LIMIT_MIRROR;
    return spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify(payloadOf({
        error: "server_error", error_details: "server_error", last_assistant_message: "API Error: server_error",
      })),
      encoding: "utf8", env,
    });
  }
  function stateSubdirMirrorPath(tag, hookPath) {
    return path.join(rootOf(hookPath || REAL_HOOK), "_tmp", TAG, tag, "state", "mirror-fallback", "fired.log");
  }

  const tag = "m5-real";
  const r = runStateSubdirOnly(REAL_HOOK, tag);
  check("现状：只指 STATE_SUBDIR（不指 MARKER/MIRROR）→ exit 0", r.status === 0, "code=" + r.status);
  const mp = stateSubdirMirrorPath(tag);
  const lines = (() => {
    try { return fs.readFileSync(mp, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); }
    catch (_) { return []; }
  })();
  check("现状：镜像落在 ROOT/_tmp/<STATE_SUBDIR>/mirror-fallback/fired.log（分支②的产物）",
    lines.length === 1 && lines[0].mirror === true, "期望路径=" + mp + " 内容=" + JSON.stringify(lines));
  check("现状：假 home 默认落点没被写入（证明这次真的走的是分支②，不是滑到了分支③）",
    !fs.existsSync(legacyDefaultPath));

  // ── 先破再验：把分支②架空 ⇒ 上面那条「镜像落在 STATE_SUBDIR 下」必须翻面 ────────────
  const ANCHOR = "  if (process.env.DAO_RATE_LIMIT_STATE_SUBDIR) {";
  const h = mutantHook("state-subdir-disabled", ANCHOR, "  if (false && process.env.DAO_RATE_LIMIT_STATE_SUBDIR) {");
  const tagM = "m5-mut";
  const rm = runStateSubdirOnly(h, tagM);
  check("canary：变异体还活着（fired.log 主账照记——分支②的改动只影响镜像去哪，不影响主账）",
    rm.status === 0 && firedLines(tagM, h).length === 1, "code=" + rm.status);
  check("🔴 先破再验：分支②被架空 ⇒ 不再落 STATE_SUBDIR 那条镜像路径，改滑到假 home 默认值（M5 断言不是摆设）",
    !fs.existsSync(stateSubdirMirrorPath(tagM, h)) && fs.existsSync(legacyDefaultPath),
    "STATE_SUBDIR 路径仍存在=" + fs.existsSync(stateSubdirMirrorPath(tagM, h)));
}

console.log("\n=== M6 + E1（issue #217）：三个 env 全不指 → 落生产默认路径，字面「dao-state」被钉住 ===");
{
  // 前情（出处 PR #212 对抗评论）：
  //   M6 —— 生产默认落点的字面段从 "dao-state" 改成 "dao-state-MUTANT"，156 条零红：
  //     头注写着「两者都不传时逐字不变」，这句话此前没有任何断言在守。
  //   E1 —— 三个环境变量一个都不指的调用方，仍然会落进真实 `~/.claude/dao-state/`；
  //     这一格此前**没有测试覆盖**（沙箱兜底只覆盖了「指了任一变量」的三种组合）。
  // 补法与 PR #212 对抗官自己用的手法同源（**不真跑 main()**，只 require 读
  // `MIRROR_LOG` 这个模块加载期就算好的导出值）：真写一次就等于把 #201 笔2 要治的那个
  // 「合成样本污染真实样本井」的病再犯一遍；读导出值零落盘、零风险，且同时验两件事——
  // 这条路径确实会被走到（E1）与它的字面值对不对（M6）。
  // 安全网：即便这条判据本身有 bug，也不能让子进程碰到使用者本机真实的
  // `~/.claude/dao-state`——把 USERPROFILE/HOME 一并指进假 home。
  const fakeHome = path.join(BASE, "m6-e1-home");
  fs.mkdirSync(fakeHome, { recursive: true });
  const expectDefault = path.join(fakeHome, ".claude", "dao-state", "rate-limit-sentinel", "fired.log");

  function mirrorLogOf(hookPath) {
    const env = Object.assign({}, process.env, { USERPROFILE: fakeHome, HOME: fakeHome });
    delete env.DAO_RATE_LIMIT_MARKER;
    delete env.DAO_RATE_LIMIT_STATE_SUBDIR;
    delete env.DAO_RATE_LIMIT_MIRROR;
    const rr = spawnSync(process.execPath,
      ["-e", "process.stdout.write(String(require(process.argv[1]).MIRROR_LOG))", hookPath],
      { encoding: "utf8", env });
    return { out: String(rr.stdout || "").trim(), code: rr.status, err: String(rr.stderr || "") };
  }

  const real = mirrorLogOf(REAL_HOOK);
  check("E1 前提：三个变量都不指时，算出的 MIRROR_LOG 是绝对路径（空串 === 空串是最容易的假绿）",
    real.code === 0 && path.isAbsolute(real.out), "real=" + JSON.stringify(real));
  check("🔴 E1：这一格真的会被走到——落点正是 <假 HOME>/.claude/dao-state/rate-limit-sentinel/fired.log" +
    "（此前无测试覆盖；真实调用方会落进使用者本机同构的真实路径）",
    real.out === expectDefault, "得 " + real.out + " 期望 " + expectDefault);

  // ── 先破再验（M6）：把默认分支里的字面段 "dao-state" 改成 "dao-state-MUTANT" ──────
  const ANCHOR = '    ".claude", "dao-state", "rate-limit-sentinel", "fired.log");';
  const h = mutantHook("default-landing-literal", ANCHOR,
    '    ".claude", "dao-state-MUTANT", "rate-limit-sentinel", "fired.log");');
  const mut = mirrorLogOf(h);
  check("canary：变异体还活着（照常算出一个绝对路径，不是崩了才不等）",
    mut.code === 0 && path.isAbsolute(mut.out), "mut=" + JSON.stringify(mut));
  check("🔴 先破再验：生产默认落点的字面段被改动 ⇒ MIRROR_LOG 的值翻面（头注「逐字不变」终于有断言在守，M6 断言不是摆设）",
    mut.out !== real.out && /dao-state-MUTANT/.test(mut.out), "mut.out=" + mut.out);
}

console.log("\n=== 负控 · 宿主失效态两格（#190 第 4 条：模块加载期崩 / stdout 写不动）===");
{
  // ㈠ **模块加载期崩**：`require` 就失败 ⇒ 连 `main()` 都没进，最外层 catch 也兜不到
  //    （它在 `require.main === module` 那个块里，而那个块根本没执行到）。
  //    这一格问的是**宿主怎么处置**：非 0 非 2 的退出码 = non-blocking error ⇒ 动作照常放行
  //    （`[#守-宿主失效态]`）。所以判据是「**不是 2**」，而不是「是 1」—— 押死具体数字会在
  //    node 改退出码的那天误红，而真正承重的不变量只有「别伪装成 block」这一条。
  const crashDir = path.join(BASE, "loadcrash", "ccswitch", "hooks");
  fs.mkdirSync(crashDir, { recursive: true });
  const crashHook = path.join(crashDir, "dao-rate-limit-sentinel.js");
  fs.copyFileSync(REAL_HOOK, crashHook);      // 刻意**不**拷 ../lib/hook-selfcheck.js
  const rc = spawnSync(process.execPath, [crashHook], {
    input: JSON.stringify(payloadOf()), encoding: "utf8", env: envFor("loadcrash"),
  });
  check("模块加载期崩 → 退出码非 0（宿主 transcript 会打一行 non-blocking error，不静默）",
    rc.status !== 0, "code=" + rc.status);
  check("🔴 模块加载期崩 → 退出码**不是 2**（2 才是 block；伪装成拦截才是真事故）",
    rc.status !== 2, "code=" + rc.status);
  check("模块加载期崩 → stdout 零输出（没有半帧 JSON 去毒害宿主解析）",
    (rc.stdout || "") === "", "out=" + JSON.stringify(String(rc.stdout || "").slice(0, 120)));
  check("前提：它崩的原因确实是加载期（stderr 里是 MODULE_NOT_FOUND，不是别的）",
    /Cannot find module|MODULE_NOT_FOUND/.test(rc.stderr || ""), "err=" + String(rc.stderr || "").slice(0, 200));

  // ㈡ **stdout 写不动（EPIPE 形态）**：用 `node -r <桩>` 在真 hook 之前把 `process.stdout.write`
  //    换成一个必抛 EPIPE 的实现 —— **被测文件一个字节没改**，只是它的 stdout 变成了敌对环境。
  //    ⚠ 照直写这是**替身不是真 EPIPE**：真 EPIPE 要读端提前关闭的管道，Windows 上不可靠复现；
  //    它验的是「写 stdout 抛异常时本 hook 仍走完落盘并 exit 0」这条不变量，而那正是承重的一格。
  const stub = path.join(BASE, "epipe-stub.js");
  fs.writeFileSync(stub,
    'process.stdout.write = function () { const e = new Error("write EPIPE"); e.code = "EPIPE"; throw e; };\n',
    "utf8");
  const tag = "epipe";
  const re = spawnSync(process.execPath, ["-r", stub, REAL_HOOK], {
    input: JSON.stringify(payloadOf({ last_assistant_message: "API Error: Rate limit reached · 约 2 小时后重置" })),
    encoding: "utf8", env: envFor(tag),
  });
  check("stdout 写不动 → 仍 exit 0（emit 的 write 被 try 包着，不许把它变成崩溃）",
    re.status === 0, "code=" + re.status + " err=" + String(re.stderr || "").slice(0, 160));
  const em = readJson(markerPath(tag));
  check("🔴 stdout 写不动 → 标记照写（主产物是落盘，不是那行 stdout）",
    em !== null && em.reset_estimate_s === 7200, "marker=" + JSON.stringify(em));
  check("stdout 写不动 → fired.log 照记", firedLines(tag).length === 1, "fired=" + JSON.stringify(firedLines(tag)));
  check("stdout 写不动 → 镜像域照记", mirrorLines(tag).length === 1);
}

console.log("\n=== --selfcheck 第③段：留痕域可写性（两态 + 归因）===");
{
  // 加固前 `--selfcheck` 只有两段（注册 / 心跳），**没有任何东西问过「写得进去吗」**：
  // 主域坏掉时它照报「无真实触发记录」—— 而那句话与「没被限流过」长得一模一样。
  const okR = spawnSync(process.execPath, [REAL_HOOK, "--selfcheck"], {
    input: "", encoding: "utf8", env: envFor("sc-writable"),
  });
  const okOut = String(okR.stdout || "");
  check("正态：两个域都可写 ⇒ 各打一条 ✓（主域 / 镜像域分开报）",
    /✓ 留痕域可写：主域/.test(okOut) && /✓ 留痕域可写：镜像域/.test(okOut), okOut.slice(-400));

  // 负态：只弄坏主域，镜像照旧 ⇒ **一条 ✗ 一条 ✓**。
  // 「只查一个域」的写法在这里就分不开「主域坏了」与「两个都坏了」，而处置完全不同。
  const blocker = path.join(BASE, "sc-broken");
  fs.writeFileSync(blocker, "普通文件", "utf8");
  const env = Object.assign({}, envFor("sc-broken-tag"), {
    DAO_RATE_LIMIT_STATE_SUBDIR: path.posix.join(TAG, "sc-broken", "state"),
  });
  const badR = spawnSync(process.execPath, [REAL_HOOK, "--selfcheck"], { input: "", encoding: "utf8", env });
  const badOut = String(badR.stdout || "");
  check("负态：主域写不进去 ⇒ 打 ✗ 并点名是主域",
    /✗ 留痕域写不进去：主域/.test(badOut), badOut.slice(-500));
  check("🔴 负态：✗ 那行必须明说它会污染第②段的结论（否则读者会把「无记录」读成「没触发过」）",
    /可能只是写不进去，不是没触发过/.test(badOut), badOut.slice(-500));
  check("负态：镜像域仍报 ✓ ⇒ 两个域分得开、归因到具体哪一个",
    /✓ 留痕域可写：镜像域/.test(badOut), badOut.slice(-500));
  check("负态：selfcheck 退出码 1（有 bad 就不许当过）", badR.status === 1, "code=" + badR.status);
}

console.log("\n=== --selfcheck 的 covers 判定（喂合成 settings，四态 + 判别力）===");
{
  // 加固前这一格**零守护**：`covers` 写成恒真也没有任何断言会红，而它答的是
  // 「限流真发生时这个 hook 到底会不会被调用」—— 判错就是整个机制静默失效。
  // 做法：给子进程一个**沙箱 HOME**（`USERPROFILE`/`HOME`），于是库里的 LIVE_SETTINGS
  // 指向我们现造的那份 settings.json —— **不给被测文件加任何测试专用的缝**。
  function scWith(tag, settingsObj, script) {
    const home = path.join(BASE, "home-" + tag);
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    if (settingsObj !== null) {
      fs.writeFileSync(path.join(home, ".claude", "settings.json"),
        JSON.stringify(settingsObj, null, 2), "utf8");
    }
    const env = Object.assign({}, envFor("sc-" + tag), { USERPROFILE: home, HOME: home });
    const r = spawnSync(process.execPath, [script || REAL_HOOK, "--selfcheck"],
      { input: "", encoding: "utf8", env });
    return String(r.stdout || "");
  }
  const reg = (matcher, name) => ({
    hooks: {
      StopFailure: [{
        matcher,
        hooks: [{ type: "command", command: 'node "D:/x/ccswitch/hooks/' + (name || "dao-rate-limit-sentinel.js") + '"' }],
      }],
    },
  });

  check("正控：matcher \"rate_limit|overloaded\" ⇒ ✓ 已注册（这个 matcher 认得出 error=rate_limit）",
    /✓ 已注册于 StopFailure/.test(scWith("covered", reg("rate_limit|overloaded"))));
  check("正控：matcher 为空 ⇒ ✓（空 = 全部 error 类型）",
    /✓ 已注册于 StopFailure/.test(scWith("empty", reg(""))));
  const un = scWith("uncovered", reg("authentication_failed"));
  check("🔴 负控：matcher 覆盖不到 rate_limit ⇒ ✗ 已注册（注册在、但这个 hook 永远不会被叫醒）",
    /✗ 已注册于 StopFailure/.test(un), un.slice(0, 400));
  check("负控：✗ 那行说得出后果（「与『没限流』长得一样」这句是它唯一的价值）",
    /限流发生时本 hook 根本不会被调用/.test(un), un.slice(0, 400));
  check("负控：settings 里只有别的 hook ⇒ ✗ 未注册（不许因为「有 hooks 段」就当成读到了自己）",
    /✗ 未注册/.test(scWith("otherhook", reg("rate_limit", "dao-rule-echo.js"))));
  check("负控：连 settings.json 都没有 ⇒ ✗ 读取/解析失败（不许静默当成已注册）",
    /✗ (读取\/解析 settings\.json 失败|未注册)/.test(scWith("nosettings", null)));

  // ── 先破再验（就近放）：covers 改恒真 ⇒ 上面那条「✗ 已注册」必须翻面 ──────────────
  // 加固之前这一格是**零守护**：把 covers 写成 `() => true`，全套断言一条都不会红。
  {
    const ANCHOR = '    covers: (m) => m === "" || m === "*" || safeRe(m, "rate_limit"),';
    const h = mutantHook("covers-always-true", ANCHOR, "    covers: () => true,");
    const out = scWith("covers-mut", reg("authentication_failed"), h);
    check("先破再验：covers 恒真 ⇒ 覆盖不到的 matcher 也报 ✓（负控组真的在测这条判据）",
      /✓ 已注册于 StopFailure/.test(out) && !/✗ 已注册于 StopFailure/.test(out), out.slice(0, 400));
    check("canary：变异体还活着（自检照跑、报头照打，不是崩了才没有 ✗）",
      /dao-rate-limit-sentinel --selfcheck/.test(out), out.slice(0, 200));
  }
}

// ⚠ 本节只放**判据类**那三向；#190 新增的三向（外层 catch / covers 判定 / 镜像通道）
//   **就近放在它们各自那一节里** —— 一个 mutation 与它该打红的那条断言隔着 200 行，
//   下一次有人改那条断言时不会想起还有个 mutation 在守它。
console.log("\n=== mutation · 判据三向（锚点单行、断言与 replace 同一个字符串）===");
{
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

  // 方向④「算出来的值被掐成 null」：标记照写、8 个字段照齐、`reset_estimate_s` 照对，
  //   只有 `reset_estimate_at` 恒 null —— 这一格在 #190 之前**无人查**（断言名写着「五格」）。
  //   它与方向③ 不同类：③ 打的是解析式（连 `reset_estimate_s` 一起变 null），
  //   ④ 只打**派生字段**，`reset_estimate_s` 仍然是 11520 ⇒ 只有那条新增的值断言逮得住。
  {
    const ANCHOR = "        reset_estimate_at: seconds == null ? null : new Date(Date.now() + seconds * 1000).toISOString(),";
    const h = mutantHook("null-reset-at", ANCHOR, "        reset_estimate_at: null,");
    const p = payloadOf({ last_assistant_message: "API Error: Rate limit reached · 约 3 小时 12 分钟后重置" });
    run(h, p, "mutA-after");
    const after = readJson(markerPath("mutA-after"));
    check("派生字段方向：reset_estimate_at 被掐成 null ⇒ 那条值断言变红（此前这一格是真空的）",
      after !== null && after.reset_estimate_at === null, "marker=" + JSON.stringify(after));
    check("canary：变异体还活着**且骗得过存在性断言**（8 个键照在、reset_estimate_s 照对 11520）—— " +
      "正是这一向只有值断言逮得住的证明",
      after && Object.prototype.hasOwnProperty.call(after, "reset_estimate_at") &&
      after.reset_estimate_s === 11520 && after.reset_parse === "cn-carpool",
      "marker=" + JSON.stringify(after));
  }

  check("canary 恒等：真 hook 文件全程未被改动",
    crypto.createHash("sha256").update(fs.readFileSync(REAL_HOOK)).digest("hex") === SHA_BEFORE);
}

console.log("\n=== 跨文件一致性：两个 hook 必须认同一个标记路径（文本 + 运行期两层）===");
{
  // 哨兵写 A、闸门读 B 这种错，**两边各自的日志都正常**，只有真限流那一次才会现形，
  // 而那一次没人在看。
  const GATE_HOOK = path.join(REPO, "ccswitch", "hooks", "dao-probe-gate.js");
  const gate = fs.readFileSync(GATE_HOOK, "utf8");
  const LINE = 'const MARKER_PATH = process.env.DAO_RATE_LIMIT_MARKER || path.join(ROOT, "_tmp", "rate-limit-interrupt.json");';
  check("① 文本层：哨兵与闸门的 MARKER_PATH 定义逐字相同（env 名 + 默认路径都同）",
    fs.readFileSync(REAL_HOOK, "utf8").includes(LINE) && gate.includes(LINE));

  // ── ② 运行期层（issue #190 第 4 条）───────────────────────────────────────
  // 文本层**只证明那一行长得一样**，它对两类形态天然失明：
  //   ㈠ 那一行依赖的东西被改了（`ROOT` 算法一侧改了、另一侧没改）—— 行文本一个字符没动
  //   ㈡ 后续又赋了一次值 / 另一处覆写
  // 故这里各自 **spawn 一个进程**、把覆写口 `DAO_RATE_LIMIT_MARKER` **摘掉**，
  // 让两个 hook 各自算一遍**运行期真值**再比对。
  // 🔑 摘掉那个 env 是承重的一步：不摘，两边都等于同一个注入值 ⇒ 这条断言**恒真**。
  function runtimeMarkerOf(hookPath) {
    const env = Object.assign({}, process.env);
    delete env.DAO_RATE_LIMIT_MARKER;
    const r = spawnSync(process.execPath,
      ["-e", "process.stdout.write(String(require(process.argv[1]).MARKER_PATH))", hookPath],
      { encoding: "utf8", env });
    return { out: String(r.stdout || "").trim(), code: r.status, err: String(r.stderr || "") };
  }
  const a = runtimeMarkerOf(REAL_HOOK);
  const b = runtimeMarkerOf(GATE_HOOK);
  check("② 前提：两侧都真的算出了一个绝对路径（空串 === 空串 是最容易的假绿）",
    a.code === 0 && b.code === 0 && path.isAbsolute(a.out) && /rate-limit-interrupt\.json$/.test(a.out),
    "a=" + JSON.stringify(a) + " b=" + JSON.stringify(b));
  check("② 运行期层：两个 hook 各自 spawn 算出的 MARKER_PATH 逐字相等",
    a.out === b.out, "哨兵=" + a.out + " 闸门=" + b.out);

  // ── 先破再验：造一对**文本层查不出来**的分岔 ──────────────────────────────
  // 只改哨兵那一侧的 `ROOT` 算法（多退一层目录）。`MARKER_PATH` 那一行**逐字不动** ⇒
  // 文本断言照常绿，只有运行期断言红。**这一格本身就是「为什么需要运行期层」的实证。**
  const ROOT_LINE = 'const ROOT = path.resolve(__dirname, "..", "..");';
  check("靶点唯一（与下面 replace 用的是同一个字符串）",
    SRC.split(ROOT_LINE).length === 2, `出现 ${SRC.split(ROOT_LINE).length - 1} 次`);
  {
    const twinDir = path.join(BASE, "twin-rootshift", "ccswitch", "hooks");
    const twinLib = path.join(BASE, "twin-rootshift", "ccswitch", "lib");
    fs.mkdirSync(twinDir, { recursive: true });
    fs.mkdirSync(twinLib, { recursive: true });
    for (const d of new Set([...relRequiresOf(SRC), ...relRequiresOf(gate)])) {
      const from = path.resolve(path.dirname(REAL_HOOK), d);
      const to = path.resolve(twinDir, d);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
    const mutSentinel = path.join(twinDir, "dao-rate-limit-sentinel.js");
    const mutGate = path.join(twinDir, "dao-probe-gate.js");
    fs.writeFileSync(mutSentinel,
      SRC.replace(ROOT_LINE, 'const ROOT = path.resolve(__dirname, "..", "..", "..");'), "utf8");
    fs.writeFileSync(mutGate, gate, "utf8");
    const ma = runtimeMarkerOf(mutSentinel);
    const mb = runtimeMarkerOf(mutGate);
    check("canary：变异体还活着（两侧都照常算出一个绝对路径，不是崩了才不相等）",
      ma.code === 0 && mb.code === 0 && path.isAbsolute(ma.out) && path.isAbsolute(mb.out),
      "ma=" + JSON.stringify(ma) + " mb=" + JSON.stringify(mb));
    check("🔴 先破再验：只改哨兵的 ROOT 算法 ⇒ 运行期值分岔（运行期那条断言不是摆设）",
      ma.out !== mb.out, "哨兵=" + ma.out + " 闸门=" + mb.out);
    check("🔴 同一变异下**文本层照常绿** ⇒ 这就是文本比对失明的实证（不是推测）",
      fs.readFileSync(mutSentinel, "utf8").includes(LINE) &&
      fs.readFileSync(mutGate, "utf8").includes(LINE));
  }
}

try { fs.rmSync(BASE, { recursive: true, force: true }); } catch (_) {}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
