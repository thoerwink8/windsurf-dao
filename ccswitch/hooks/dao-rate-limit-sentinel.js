// dao-rate-limit-sentinel.js — StopFailure · 限流瞬间在本地留下一个「我被打断了」的标记
//
// ── 它在补哪个洞（issue #184）─────────────────────────────────────────────────
// 账号级限流打断会话时，**AI 那一侧买不起任何一次推理**：请求被拒 = 推理没发生 =
// 没人有机会写下「我断在哪、什么时候能回来」。于是恢复之后靠的是盲撞探针
// （固定间隔起一轮，问一句「有没有被限流打断的活」），而盲撞的代价是**无事时也要撞**。
// 本 hook 走 `StopFailure`：turn 因 API error 终止时宿主**必触发**它，而 hook 是本地进程、
// **零额度**。于是「断了」这件事在没有推理预算的情况下也能被记下来。
// 配套的另一半是 `dao-probe-gate.js`（UserPromptSubmit）：探针轮读这个标记，
// 没标记就把那一轮当场拦掉 ⇒ 无事时探针 0 轮，有事时 ≤ 一个探针周期即接手。
//
// ── 宿主协议：哪些是本机实证的、哪些只有文档（禁笃定措辞，逐条标依据）────────
//   ✅ **payload 字段（本机 exe 字节级取证，2026-08-08）**：claude.exe 里构造 StopFailure
//      输入的那一段字面量是
//      `{...common, hook_event_name:"StopFailure", error:s, error_details:e.errorDetails,
//        last_assistant_message:i}`，其中 `s = e.error ?? "unknown"`，且
//      `matchQuery: s` —— **matcher 匹配的就是 `error` 这个字符串**。
//      同一份 exe 里的输入 schema 另有 `hook_event_name:"StopFailure", error, error_details?,
//      last_assistant_message?`。⇒ 与官方文档快照（`_tmp/hookdocs/hooks.md:2408-2434`）一致。
//   ✅ 文档：`error` 值域 = rate_limit / overloaded / authentication_failed /
//      oauth_org_not_allowed / billing_error / invalid_request / model_not_found /
//      server_error / max_output_tokens / unknown（10 种）；
//      `last_assistant_message` 在本事件下装的是 **API 报错原文**（如 `"API Error: Rate limit reached"`），
//      与 Stop/SubagentStop 下的语义不同。
//   ✅ 文档：**StopFailure 是 informational —— 输出与退出码一律被忽略**（`hooks.md:2434` 与
//      退出码分事件表 `:792`「Output and exit code are ignored」）。⇒ 本 hook 唯一的产出是**落盘**，
//      stdout 写什么都不影响宿主。这也意味着**它出错时不会有任何人看见**，故三重留痕照写。
//   ❌ **没有结构化的重置时间字段**。四格验证收将评论里那句「`retry_after` ⇒ 不用解析文案」
//      已于 2026-08-08 前提批作废（该字段全文 0 命中）。重置时间只能从文本里宽容解析，见下。
//
// ── 重置时间：两式，且**两式的证据强度不一样**（照直写）──────────────────────
// 语料来源限定 issue #184 前提批给的两式，**刻意不自造第三式**（近似判据的语料若由本轮
// 自己构造，只能证明「我编的样本我认得出」）：
//   · **中文拼车文案「约 X 小时 Y 分钟后重置」** —— 出处是用户 2026-08-07 提供的**真实限流截图**
//     （#184 评论「精准撞结论修正」逐字引用了这个形态）。这一式有真实语料背书。
//   · **英文「Rate limit reached」类** —— **只有类名，盘上没有一条带重置时间的真实样本**。
//     文档给出的两个实例（`"API Error: Rate limit reached"` / `"429 Too Many Requests"`）
//     **都不含重置时间**，按本 hook 的判据双双解析为 null —— 那正是预期行为，不是缺陷。
//     故英文式只做一件最保守的事：**在确认是这一类报错的前提下**，捞一个 10 位 epoch 秒。
//     ⇒ **这一式的判别力目前只由合成语料提供**，真实命中率未测。`reset_parse` 字段
//     （记本次是哪一式命中的）就是为了把这个空白变成攒得出来的数据：fired.log 攒够真实
//     样本后，回头看英文式到底命中过没有，再决定是收窄还是补形态。
// 解析不出一律记 **null**，标记照写 —— 中断时刻本身已经够探针接手用了，重置估时是锦上添花。
//
// ── 只对两种 error 写标记，其余只记日志 ──────────────────────────────────────
// 注册层的 matcher 是 `rate_limit|overloaded`（本事件的 matcher 字符集只认字母/数字/`_`/`|`，
// 不能用逗号或空格 —— `hooks.md:291`）。**hook 内仍再判一次**：matcher 语义万一变更
// （或有人把注册改成 `*`），不至于让「任何 API 错误」都伪装成限流去唤醒一轮探针。
// 判据是 `MARKED_ERRORS` 这个集合，其余 8 种只进 fired.log（`marked:false`）——
// **不写标记 ≠ 不记账**：观测数据是这个机制将来调参的唯一依据。
//
// ── 全域分布（建护栏前先摸分布，dao-guard-writing 第 1 条）────────────────────
// 本 hook 上线前，本仓 `ccswitch/hooks/` 下 15 个 hook **一个都没挂在 StopFailure 上**，
// 快照 `config-sync/common/settings.json` 的 hooks 段里也没有 StopFailure 这个键
// ⇒ 这是一个**全新的挂载点**，不存在「和谁抢预算」的问题，也不会与既有闸的语义打架。
// 反过来说：**这个挂载点此前从未在本机被触发过一次**，故「它到底会不会响」在真限流发生前
// 只有文档与 exe 取证，没有实况——`--selfcheck` 的第②段（真实心跳）就是等那一刻的。
//
// ── fail-open 铁律 ───────────────────────────────────────────────────────────
// 宿主对 `command` 型 hook 的失效态本来就是 fail-open（`[#守-宿主失效态]`），而本事件
// 更彻底：输出与退出码都被忽略。⇒ 本 hook **任何异常一律 exit 0 + 写 errors.log**，
// 永不阻塞宿主。**它唯一的失败形态是「什么都没记下来」，而那与「本次没有限流」长得一样**
// —— 这正是三重留痕（stderr + errors.log + 心跳）存在的理由。
// ⚠ 对抗实测（2026-08-08）：「三重」并不构成三个独立域——errors.log 与心跳同住
// `<仓根>/_tmp`（与标记文件同域），stderr 在本事件下被宿主直接丢弃 ⇒ 仓根 `_tmp` 坏掉
// 即全部通道同时哑掉且 exit 0。单点加固挂 issue #190 第 2 条。
//
// ── 输出面不在扫描面内（守卫铁律③）──────────────────────────────────────────
// 本 hook 的输入是 stdin 的 payload，产出全部落在 `<仓根>/_tmp/`（已 gitignore）。
// 两者没有交集 ⇒ 报告不可能被自己重新读进来。
//
// 回归网：tests/rate-limit-sentinel.tests.js
// 真相源：windsurf-dao/ccswitch/hooks/dao-rate-limit-sentinel.js
// 注册（用户/帅动作，本文件不代做）：settings.json → hooks.StopFailure，matcher "rate_limit|overloaded"

"use strict";

const fs = require("fs");
const path = require("path");
const { createHookScaffold } = require("../lib/hook-selfcheck.js");

const SIGNATURE = "[dao-rate-limit-sentinel v1]";
const EVENT = "StopFailure";
const ROOT = path.resolve(__dirname, "..", ".."); // 本文件在 <root>/ccswitch/hooks/

// ── 标记文件的位置：**按 __dirname 推，不按 payload.cwd 推** ──────────────────
// 理由：这个标记是**机器级事实**（这台机器上的这个账号被限流了），不是项目级事实；
// 而 payload.cwd 随你在哪个项目里被限流而变 ⇒ 用它推路径会让哨兵写到 A 处、
// 探针闸门（跑在别的项目里）去 B 处找，两边各自看都正常。__dirname 对两个 hook 恒等，
// 因为它们是同一次部署里的同两个文件。
// env 覆写是测试缝（两个 hook 读**同一个**变量名，测试指一次就够）。
const MARKER_PATH = process.env.DAO_RATE_LIMIT_MARKER || path.join(ROOT, "_tmp", "rate-limit-interrupt.json");

// 写标记的 error 类型。其余 8 种只进 fired.log —— 理由见头注。
const MARKED_ERRORS = new Set(["rate_limit", "overloaded"]);

// raw 摘录长度。300 是 spec 定的：够装下一整句报错文案（含重置时间那半句），
// 又不至于把整段 stack 灌进标记文件里让探针轮读一屏噪音。
const RAW_MAX = 300;

// 重置估时的上界（秒）。**它挡的不是"太久"，是"这个数根本不是时间"**——
// 报错文本里混着请求 ID、build 号之类的长数字，捞到一个就当重置时刻会排出一个荒谬的撞点。
// 调参三问（取 7 天）：①改小 ⇒ 真实的**周级**限额窗被判 null，退化成盲撞兜底（安全侧，
// 只是丢了精准层）；②当前值够不够 ⇒ 已知最长的账号级限流窗是周级，7 天覆盖它；
// ③7 天到「够用下界（5 小时窗）」之间那段有没有真实需求 —— 有，周限额就住在那段里，
// 故不取更小。
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
 *   how 不只是调试字段：它是**这两式在真实语料上到底哪一式在干活**的唯一出口（见头注）。
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

const S = createHookScaffold({
  name: "dao-rate-limit-sentinel",
  // 状态目录可由 env 改写：测试要攒自己的 fired.log，而生产那份是**实战限流样本的耐久数据**
  // （#184 的遗留观测格就指着它）——把合成样本掺进去等于污染将来那次复盘的结论。
  stateSubdir: process.env.DAO_RATE_LIMIT_STATE_SUBDIR || "rate-limit-sentinel",
  failTail: "本次限流中断没有被记下来，探针轮将查不到标记（退化为盲撞）",
  forceErrorEnv: "DAO_RATE_LIMIT_FORCE_ERROR",
  selfTestEnv: "DAO_RATE_LIMIT_SELFTEST",
});

// 标记文件整份覆写（后一次限流覆盖前一次）。**幂等**：连发两次不炸、内容以最后一次为准。
// 探针接手后由探针那一轮删除它（见 dao-probe-gate.js 头注的分工），本 hook 只写不删。
function writeMarker(rec) {
  fs.mkdirSync(path.dirname(MARKER_PATH), { recursive: true });
  fs.writeFileSync(MARKER_PATH, JSON.stringify(rec, null, 2), "utf8");
}

function selfcheck() {
  S.runSelfcheckCli({
    event: EVENT,
    scriptName: "dao-rate-limit-sentinel.js",
    // matcher 匹配的是 error 字符串本身（本机 exe 取证：matchQuery = error）。
    // 覆盖判据因此是「这个 matcher 认不认 rate_limit」，不是字面等于某个串。
    covers: (m) => m === "" || m === "*" || safeRe(m, "rate_limit"),
    matcherLabel: (m) => (m === "" ? "(空=全部 error 类型)" : m),
    coversFailNote:
      " ⇒ matcher 匹配不到 error=\"rate_limit\"，限流发生时本 hook 根本不会被调用（而那与「没限流」长得一样）",
    logPath: S.firedLog,
    missNote: "matcher 与 error 类型名",
    describeLast: (l) => `error=${l.error} · 写标记=${l.marked} · 重置估时=${l.reset_estimate_s}s(${l.reset_parse})`,
    staleDays: 90,
    staleNote: (d) =>
      `ⓘ 末次真实触发在 ${d} 天前 —— 这**未必**是接线断了：没被限流过就该是这个样子。` +
      "两者在日志上长得一样，判不出来时以 ① 的注册核验为准。",
    logReadFailLabel: "读取心跳日志失败",
  });
}

function safeRe(m, sample) {
  try { return new RegExp(m).test(sample); } catch (_) { return false; }
}

function main() {
  let input = null;
  let inputErr = null;
  try {
    S.maybeForceError("parse");
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
    S.appendErrorLog(msg, inputErr);
    S.heartbeat({
      at: new Date().toISOString(), synthetic: true, error: null, marked: false,
      reset_estimate_s: null, reset_parse: null, error_message: String(inputErr && inputErr.message),
    });
    process.exit(0);
  }

  const error = String(input.error || "unknown");
  const details = input.error_details == null ? "" : String(input.error_details);
  const lastMsg = input.last_assistant_message == null ? "" : String(input.last_assistant_message);
  const raw = `${details} ${lastMsg}`.trim().slice(0, RAW_MAX);
  const { seconds, how } = parseResetSeconds(`${details}\n${lastMsg}`, Date.now());
  const at = new Date().toISOString();
  const marked = MARKED_ERRORS.has(error);

  let markerErr = null;
  if (marked) {
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
      });
    } catch (e) {
      markerErr = e;
      const msg = `[dao-rate-limit-sentinel] 写标记失败（${MARKER_PATH}）：${e && e.message}`;
      try { process.stderr.write(msg + "\n"); } catch (_) {}
      S.appendErrorLog(msg, e);
    }
  }

  S.heartbeat({
    at,
    synthetic: S.isSynthetic(input),
    session_id: input.session_id || null,
    error,
    marked: marked && !markerErr,
    reset_estimate_s: seconds,
    reset_parse: how,
    marker: marked ? MARKER_PATH : null,
    marker_error: markerErr ? String(markerErr.message) : null,
    raw,
  });

  // StopFailure 的输出被宿主忽略，这一行只为让手工空跑（和测试）看得见本次判定。
  S.emit({ systemMessage: `${SIGNATURE} error=${error} 写标记=${marked && !markerErr} 重置估时=${seconds == null ? "未解析出" : seconds + "s"}` });
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
      try { S.appendErrorLog(msg, e); } catch (_) {}
      process.exit(0);
    }
  }
}

// 供测试直接单验解析式（端到端跑进程验不到「哪一式命中」这一格的边界值）
module.exports = { parseResetSeconds, MARKED_ERRORS, MARKER_PATH, MAX_RESET_S, SIGNATURE };
