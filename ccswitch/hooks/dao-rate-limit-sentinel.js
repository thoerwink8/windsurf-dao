// dao-rate-limit-sentinel.js — 「这一轮死于限流」的唯一物证（StopFailure · 只留痕不拦截）
//
// 改这个文件前必须知道的五条：
//
// 1. **它为什么够得上一道闸**：它失效的样子是**静默的**——hook 挂在 StopFailure 上，
//    它不写标记与它根本没被调用，在屏幕上、退出码上、日志上长得一模一样。而标记是
//    「这一轮死于限流」这件事的唯一物证：没有它，接手的人只看到会话停了，
//    不知道停在哪、也不知道什么时候能续。可逆且会被发现的失败不设闸，这一条不是。
//
// 2. **标记路径按 `__dirname` 推，不按 `payload.cwd` 推。** 这个标记是**机器级事实**
//    （这台机器上的这个账号被限流了），不是项目级事实；而 cwd 随你在哪个项目里被限流而变
//    ⇒ 用它推路径会让哨兵写到 A 处、读的人去 B 处找，**两边各自看都正常**。
//
// 3. **加固脚手架就地内联，不 require `../lib/hook-selfcheck.js`。** 理由不是「那个 lib 不好」，
//    是**闸自测要求它可搬运**：tests/rate-limit-marker.tests.js 的 mutation 把本文件复制到临时
//    目录再跑，一旦有相对 require，副本在那里根本加载不起来——于是「判据集合被改空 ⇒ 不写标记」
//    这条断言**无论变异与否都通过**，等于什么都没验（2026-08-12 实测复现：未变异的原样副本
//    在 tmp 下同样 exit 1、同样不写标记）。**主路径必须自足**，否则守它的 mutation 是空的。
//    只有 `--selfcheck` 那条诊断路仍惰性 require 那个 lib——它不进 mutation 的射程。
//
// 4. **全程只留痕、永不改变退出码。** 写标记失败、镜像失败、心跳失败一律吞掉并出声
//    （stderr + errors.log），但仍 exit 0：StopFailure 阶段会话已经死了，
//    这里再报错误态只会污染宿主对那一轮的判定。**「不阻断」≠「不出声」——静默是它最坏的死法。**
//
// 5. **`deaths_24h` 含本次**：语义是「连这次在内，过去 24h 我死了几次」。
//    读日志失败记 `null` 不记 `0`——0（真的零次）与「读不出来」必须分得开。
//    ⚠ 射程照直写：只有 `readFileSync` 真抛异常才落到 `null`；整行坏掉的 JSON 由解析器
//    静默跳过（日志是旁证，一行写坏了不该让整份日志不可读），那种情况报的是 0 不是 null。
//
// 注册（用户动作，本文件不代做）：settings.json → hooks.StopFailure，matcher "rate_limit|overloaded"。
// 闸自测：tests/rate-limit-marker.tests.js，由 node scripts/dao-check.mjs 统一跑。

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const SIGNATURE = "[dao-rate-limit-sentinel v1]";
const EVENT = "StopFailure";
const ROOT = path.resolve(__dirname, "..", ".."); // 本文件在 <root>/ccswitch/hooks/

// env 覆写是测试缝（读它的那一侧用同一个变量名，测试指一次就够）。
const MARKER_PATH = process.env.DAO_RATE_LIMIT_MARKER || path.join(ROOT, "_tmp", "rate-limit-interrupt.json");

// ── 镜像留痕域：**刻意不在 `<仓根>/_tmp` 里** ─────────────────────────────────
// errors.log / fired.log / last.json 三条通道同住 `<仓根>/_tmp/<subdir>/`，第四条 stderr 在
// 本事件下被宿主直接丢弃 ⇒ **那一个目录坏掉，四条一起哑且退出码干净**。这里给第二个物理落点：
// 它与仓根 `_tmp` 通常在不同的盘/权限域，且在仓外 ⇒ 不进 git、不被 `_tmp` 清理扫到。
// **它是镜像不是主产物**：写不成一律吞掉，永不影响退出码。
//
// 沙箱兜底：判据是「你像不像在沙箱里跑」，不是「你记没记得传 MIRROR」——后者是纪律不是结构，
// 第二个测试消费方忘传就会静默把合成样本写进真实样本井，且看不出是假的。
function deriveMirrorFallback() {
  if (process.env.DAO_RATE_LIMIT_MARKER) {
    return path.join(path.dirname(process.env.DAO_RATE_LIMIT_MARKER), "mirror-fallback", "fired.log");
  }
  if (process.env.DAO_RATE_LIMIT_STATE_SUBDIR) {
    return path.join(ROOT, "_tmp", process.env.DAO_RATE_LIMIT_STATE_SUBDIR, "mirror-fallback", "fired.log");
  }
  return path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(),
    ".claude", "dao-state", "rate-limit-sentinel", "fired.log");
}
const MIRROR_LOG = process.env.DAO_RATE_LIMIT_MIRROR || deriveMirrorFallback();

// 写标记的 error 类型。其余类型只进 fired.log。
// ⚠ 这一行是闸自测的 mutation 锚点（把集合改空 ⇒ 正控必须从「写」掉到「不写」），
//   改它的写法要同步改 tests/rate-limit-marker.tests.js 里的 ANCHOR，否则那条断言会变成空操作。
const MARKED_ERRORS = new Set(["rate_limit", "overloaded"]);

// raw 摘录长度：够装下一整句报错文案（含重置时间那半句），又不至于把整段 stack 灌进标记文件。
const RAW_MAX = 300;

// 重置估时的上界（秒）。**它挡的不是「太久」，是「这个数根本不是时间」**——报错文本里混着
// 请求 ID、build 号之类的长数字，捞到一个当重置时刻会算出一个荒谬的撞点。取 7 天是因为
// 已知最长的账号级限流窗是周级，取更小会把真实的周级窗判成 null、退化成盲撞。
const MAX_RESET_S = 7 * 24 * 3600;

// ── 两式解析（判别力靠 tests 的正负控 + mutation，不靠这两行正则自称）──────────
// 中文拼车式：「约 3 小时 12 分钟后重置」/「约 12 分钟后重置」/「约 3 小时后重置」。
// 两组都可选，但**至少要有一组**（否则「约…重置」这种没数字的句子会算出 0 秒）。
const CN_RESET_RE = /约\s*(?:(\d+)\s*个?\s*小时)?\s*(?:(\d+)\s*分钟)?\s*后?\s*重置/;
// 英文式的**类门**：先确认这是「限额到顶」那一类报错，再去捞时间戳。
// 少了这道门，任何一条含 10 位数字的报错都会被当成带重置时刻的限流 —— 那是自造第三式。
const EN_LIMIT_RE = /(?:rate|usage)\s+limit\s+reached/i;
// 10 位 epoch 秒，窗口 1600000000(2020-09) ~ 1999999999(2033-05)。
// 429 这种三位状态码不会命中；毫秒时间戳（13 位）也不会（\b 两侧夹死）。
const EPOCH_RE = /\b(1[6-9]\d{8})\b/;

/**
 * 从报错文本里解析「还有多少秒重置」。
 * @returns {{seconds:number|null, how:string|null}} how = "cn-carpool" | "en-epoch" | null
 *   how 不只是调试字段：它是**这两式在真实语料上到底哪一式在干活**的唯一出口。
 */
function parseResetSeconds(text, nowMs) {
  const s = String(text == null ? "" : text);
  const now = Number.isFinite(nowMs) ? Number(nowMs) : Date.now();

  const cn = CN_RESET_RE.exec(s);
  if (cn && (cn[1] || cn[2])) {
    const sec = Number(cn[1] || 0) * 3600 + Number(cn[2] || 0) * 60;
    if (sec > 0 && sec <= MAX_RESET_S) return { seconds: sec, how: "cn-carpool" };
  }

  if (EN_LIMIT_RE.test(s)) {
    const ep = EPOCH_RE.exec(s);
    if (ep) {
      const sec = Math.round((Number(ep[1]) * 1000 - now) / 1000);
      if (sec > 0 && sec <= MAX_RESET_S) return { seconds: sec, how: "en-epoch" };
    }
  }

  return { seconds: null, how: null };
}

// ── 留痕脚手架（就地内联，理由见头注 3）──────────────────────────────────────
// 状态目录可由 env 改写：测试要攒自己的 fired.log，而生产那份是实战限流样本的耐久数据，
// 把合成样本掺进去等于污染将来那次复盘的结论。
const STATE_DIR = path.join(ROOT, "_tmp", process.env.DAO_RATE_LIMIT_STATE_SUBDIR || "rate-limit-sentinel");
const ERROR_LOG = path.join(STATE_DIR, "errors.log");
const FIRED_LOG = path.join(STATE_DIR, "fired.log");
const LAST_JSON = path.join(STATE_DIR, "last.json");
const MAX_LOG_LINES = 2000;

// stdout 只许写一次：hook 的 stdout 是与宿主的单帧协议，写第二次会产出两个拼在一起的 JSON，
// 宿主解析失败 ⇒ 静默丢掉本次全部输出。
let stdoutUsed = false;
function emit(obj) {
  if (stdoutUsed) return;
  stdoutUsed = true;
  try { process.stdout.write(JSON.stringify(obj)); } catch (_) {}
}

function appendErrorLog(msg, err) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const stack = err && err.stack ? "\n" + err.stack : "";
    fs.appendFileSync(ERROR_LOG, `[${new Date().toISOString()}] ${msg}${stack}\n`, "utf8");
  } catch (_) {}
}

// 坏行跳过而非抛：日志是旁证，一行写坏了不该让整份日志不可读（否则「日志坏了」会被
// --selfcheck 读成「从未触发」——把一个小故障放大成误判接线已断）。
function readJsonlRecords(p) {
  if (!fs.existsSync(p)) return [];
  return String(fs.readFileSync(p, "utf8")).split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
    .filter(Boolean);
}

// 轮转：超上限即保留后半。失败吞掉——裁剪不成功不该拖垮记录本身。
function rotateJsonl(p) {
  try {
    const lines = fs.readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean);
    if (lines.length > MAX_LOG_LINES) {
      fs.writeFileSync(p, lines.slice(-Math.floor(MAX_LOG_LINES / 2)).join("\n") + "\n", "utf8");
    }
  } catch (_) {}
}

// 故障注入（自测用）。两种取值刻意分得开：`=1` 任何相位命中；`=<相位名>` 只有那一个相位命中。
// 为什么需要相位：最外层 catch 常常是**真空锚**——注入点都在内层 try 里，异常走不到外层，
// 于是「把外层 catch 改坏也没有一条断言会红」。有了相位名才能把异常投放到内层 try 之外。
function maybeForceError(stage) {
  const v = process.env.DAO_RATE_LIMIT_FORCE_ERROR;
  if (v === "1" || (v && v === stage)) {
    throw new Error(`人为注入故障（DAO_RATE_LIMIT_FORCE_ERROR=${v}）@${stage}`);
  }
}

// 心跳只有真被宿主调用过才写得出来，是「已接线」的硬证据。自测/手工空跑也会走到这里，
// 故标 synthetic，--selfcheck 只采信非 synthetic——否则单元测试的心跳会让自检误报「已生效」。
function isSynthetic(input) {
  if (process.env.DAO_RATE_LIMIT_SELFTEST === "1") return true;
  return !(input && input.transcript_path);
}

// 旁证型心跳：写 last.json + 追加 fired.log，全程吞异常。
function heartbeat(rec) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(LAST_JSON, JSON.stringify(rec, null, 2), "utf8");
    fs.appendFileSync(FIRED_LOG, JSON.stringify(rec) + "\n", "utf8");
    rotateJsonl(FIRED_LOG);
  } catch (_) { /* 心跳失败不该拖垮主产物 */ }
}

// ── 判据 ──────────────────────────────────────────────────────────────────
// 数最近 24h 内 `marked:true` 的行。**不含本次**——本次这条要等 heartbeat() 才落盘，
// 调用方自己 +1（见 main()）。
// **上界带时钟回拨容差**：只有下界的话，一条被伪造成未来时刻（哪怕 9999 年）的 `at`
// 会永久算作「在窗内」——它永远 >= cutoff，且没有任何东西会让它过期。容差吸收 NTP 校时
// 抖动导致的墙钟回拨（零容差实测会把真实死亡误判成「未来」而排除），伪造需超前 5 分钟才生效。
const DEATHS_WINDOW_MS = 24 * 3600 * 1000;
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;
function countDeaths24h(nowMs) {
  try {
    const cutoff = nowMs - DEATHS_WINDOW_MS;
    const all = readJsonlRecords(FIRED_LOG);
    let n = 0;
    for (const r of all) {
      if (r && r.marked === true) {
        const t = Date.parse(r.at);
        if (Number.isFinite(t) && t >= cutoff && t <= nowMs + CLOCK_SKEW_TOLERANCE_MS) n++;
      }
    }
    return n;
  } catch (_) {
    return null;
  }
}

// 标记文件整份覆写（后一次限流覆盖前一次）。**幂等**：连发两次不炸、内容以最后一次为准。
// 本 hook 只写不删——删是读的那一侧接手之后的事。
function writeMarker(rec) {
  fs.mkdirSync(path.dirname(MARKER_PATH), { recursive: true });
  fs.writeFileSync(MARKER_PATH, JSON.stringify(rec, null, 2), "utf8");
}

// 镜像一条记录到 `_tmp` 域**之外**。全程吞异常：它是冗余通道，不许拖垮主路径。
// 内容与 `_tmp` 那份逐字段相同 + 一个 `mirror:true`（读的人要分得出自己在看哪一份）。
function mirrorRecord(rec) {
  try {
    fs.mkdirSync(path.dirname(MIRROR_LOG), { recursive: true });
    fs.appendFileSync(MIRROR_LOG, JSON.stringify(Object.assign({ mirror: true }, rec)) + "\n", "utf8");
  } catch (_) { /* 镜像写不成不该拖垮主路径 —— `_tmp` 那侧照写 */ }
}

function safeRe(m, sample) {
  try { return new RegExp(m).test(sample); } catch (_) { return false; }
}

// 诊断路。**惰性 require**：它不在 mutation 的射程内（见头注 3），
// 而这一段的价值全在「把它到底接上没有」摆出来，不值得为它把整个 lib 抄一份。
function selfcheck() {
  const { createHookScaffold } = require("../lib/hook-selfcheck.js");
  const S = createHookScaffold({
    name: "dao-rate-limit-sentinel",
    stateSubdir: process.env.DAO_RATE_LIMIT_STATE_SUBDIR || "rate-limit-sentinel",
    failTail: "本次限流中断没有被记下来，接手的人将查不到标记",
    forceErrorEnv: "DAO_RATE_LIMIT_FORCE_ERROR",
    selfTestEnv: "DAO_RATE_LIMIT_SELFTEST",
  });
  S.runSelfcheckCli({
    event: EVENT,
    scriptName: "dao-rate-limit-sentinel.js",
    // matcher 匹配的是 error 字符串本身。覆盖判据因此是「这个 matcher 认不认 rate_limit」，
    // 不是字面等于某个串。
    covers: (m) => m === "" || m === "*" || safeRe(m, "rate_limit"),
    matcherLabel: (m) => (m === "" ? "(空=全部 error 类型)" : m),
    coversFailNote:
      " ⇒ matcher 匹配不到 error=\"rate_limit\"，限流发生时本 hook 根本不会被调用（而那与「没限流」长得一样）",
    logPath: FIRED_LOG,
    missNote: "matcher 与 error 类型名",
    describeLast: (l) => `error=${l.error} · 写标记=${l.marked} · 重置估时=${l.reset_estimate_s}s(${l.reset_parse})`,
    staleDays: 90,
    staleNote: (d) =>
      `ⓘ 末次真实触发在 ${d} 天前 —— 这**未必**是接线断了：没被限流过就该是这个样子。` +
      "两者在日志上长得一样，判不出来时以 ① 的注册核验为准。",
    logReadFailLabel: "读取心跳日志失败",
    // 两个留痕域各查一次，**刻意分开报**：只查一个的话，「主域坏了但镜像好着」与
    // 「两个都坏了」在输出里长得一样，而前者只丢观测精度、后者是这个 hook 彻底静默。
    probeDirs: [
      { label: "主域（<仓根>/_tmp）", dir: STATE_DIR,
        failNote: "（fired.log / errors.log / last.json 三样都在这里 ⇒ 它坏了这三样一起哑）" },
      { label: "镜像域（出 _tmp，本机 dao 状态）", dir: path.dirname(MIRROR_LOG),
        failNote: "（这是主域坏掉时唯一还在记账的通道 ⇒ 它也坏了就真的一条都不剩了）" },
    ],
  });
}

function main() {
  let input = null;
  let inputErr = null;
  try {
    maybeForceError("parse");
    const parsed = JSON.parse(fs.readFileSync(0, "utf8"));
    if (!parsed || typeof parsed !== "object") throw new Error("stdin JSON 不是对象");
    input = parsed;
  } catch (e) {
    inputErr = e;
  }

  if (!input) {
    // 坏输入：不写标记（写不出内容），但**必须出声**——静默是这个 hook 最坏的死法。
    const msg = `[dao-rate-limit-sentinel] 解析 stdin 失败：${inputErr && inputErr.message}`;
    try { process.stderr.write(msg + "\n"); } catch (_) {}
    appendErrorLog(msg, inputErr);
    const badRec = {
      at: new Date().toISOString(), synthetic: true, error: null, marked: false,
      reset_estimate_s: null, reset_parse: null, error_message: String(inputErr && inputErr.message),
    };
    heartbeat(badRec);
    mirrorRecord(badRec);
    process.exit(0);
  }

  // 这一行**刻意不在任何 `try` 里**：它抛出的异常只能被文件末尾那个最外层 catch 兜住。
  // 在它之前，本文件全部注入点都在上面那个内层 try 里 ⇒ 外层 catch 是**真空锚**。
  maybeForceError("outer");

  const error = String(input.error || "unknown");
  const details = input.error_details == null ? "" : String(input.error_details);
  const lastMsg = input.last_assistant_message == null ? "" : String(input.last_assistant_message);
  const raw = `${details} ${lastMsg}`.trim().slice(0, RAW_MAX);
  const { seconds, how } = parseResetSeconds(`${details}\n${lastMsg}`, Date.now());
  const at = new Date().toISOString();
  const marked = MARKED_ERRORS.has(error);

  let markerErr = null;
  if (marked) {
    // 读的是 fired.log **此刻已有**的行（这次死亡还没落盘），故 +1 把正在写的这次计进去。
    const priorDeaths24h = countDeaths24h(Date.now());
    const deaths24h = priorDeaths24h == null ? null : priorDeaths24h + 1;
    try {
      writeMarker({
        at,
        error,
        reset_estimate_s: seconds,
        reset_parse: how,
        reset_estimate_at: seconds == null ? null : new Date(Date.now() + seconds * 1000).toISOString(),
        raw,
        session_id: input.session_id || null,
        signature: SIGNATURE,
        deaths_24h: deaths24h,
      });
    } catch (e) {
      markerErr = e;
      const msg = `[dao-rate-limit-sentinel] 写标记失败（${MARKER_PATH}）：${e && e.message}`;
      try { process.stderr.write(msg + "\n"); } catch (_) {}
      appendErrorLog(msg, e);
    }
  }

  const rec = {
    at,
    synthetic: isSynthetic(input),
    session_id: input.session_id || null,
    error,
    marked: marked && !markerErr,
    reset_estimate_s: seconds,
    reset_parse: how,
    marker: marked ? MARKER_PATH : null,
    marker_error: markerErr ? String(markerErr.message) : null,
    raw,
  };
  heartbeat(rec);
  // 第二个物理落点，出 `_tmp` 域。顺序在 heartbeat 之后：`_tmp` 那份仍是主账。
  mirrorRecord(rec);

  // StopFailure 的输出被宿主忽略，这一行只为让手工空跑（和测试）看得见本次判定。
  emit({ systemMessage: `${SIGNATURE} error=${error} 写标记=${marked && !markerErr} 重置估时=${seconds == null ? "未解析出" : seconds + "s"}` });
  process.exit(0);
}

if (require.main === module) {
  if (process.argv.includes("--selfcheck")) {
    selfcheck();
  } else {
    try {
      main();
    } catch (e) {
      // 兜到这里说明上面漏了一处：仍然 exit 0（本事件的退出码本就被忽略，抛出去只会静默）
      const msg = `[dao-rate-limit-sentinel] 未捕获异常：${e && e.message}`;
      try { process.stderr.write(msg + "\n"); } catch (_) {}
      try { appendErrorLog(msg, e); } catch (_) {}
      process.exit(0);
    }
  }
}

module.exports = { parseResetSeconds, MARKED_ERRORS, MARKER_PATH, MIRROR_LOG, MAX_RESET_S, SIGNATURE };
