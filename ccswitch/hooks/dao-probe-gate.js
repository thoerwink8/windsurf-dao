// dao-probe-gate.js — UserPromptSubmit · 限流探针轮的本地闸门（无事时把那一轮当场拦掉）
//
// ── 它在补哪个洞（issue #184）─────────────────────────────────────────────────
// 限流恢复检测靠的是**盲撞探针**：定时起一轮问「有没有被限流打断的活」。撞得越密恢复越快，
// 而代价是**无事时也在撞** —— 每 5 分钟一轮 = 每天 288 轮无意义的推理与 context 污染。
// 本 hook 把这个取舍拆开：探针轮进来时先在**本地**（零额度、零推理）查一眼中断标记，
//   · **没标记 ⇒ `decision:"block"`**，那一轮根本不发生 ⇒ 无事时探针 0 轮；
//   · **有标记 ⇒ 放行**，并把标记全文用 `additionalContext` 挂上，探针轮不必自己去找。
// 标记由另一半 `dao-rate-limit-sentinel.js`（StopFailure）在限流瞬间写下。
// ⇒ 恢复速度与会话清洁两头全拿：撞得再密也不花钱，真断了 ≤ 一个探针周期就接手。
//
// ── 分工（谁写标记、谁读、谁删）──────────────────────────────────────────────
//   写：`dao-rate-limit-sentinel.js`（限流瞬间）
//   读：本 hook（每个探针轮，只读不删）
//   删：**探针轮自己**（帅侧 cron prompt 的第一步「接手前先删标记文件」）
// 本 hook **刻意不删**：删在这里的话，一旦那一轮因别的原因没跑成，标记就白丢了
// —— 而丢标记 = 那次限流中断永远没人接手，且不留痕。让消费者自己删，语义才闭合。
//
// ── 宿主协议：block 与 suppressOriginalPrompt（本机 exe 取证，不是照抄文档）──────
//   ✅ `decision:"block"` 会 **erase the prompt**（`hooks.md:784` 退出码分事件表 + `:1267`
//      「prevents the prompt from being processed and erases it from context」）。
//   🔴 **`suppressOriginalPrompt` 住在 `hookSpecificOutput` 里，不是顶层** —— 官方文档
//      `hooks.md:1265-1271` 那张表把它和 `decision`/`reason` 列在**同一张表**里，照着表写会
//      放到顶层而**静默失效**（zod 对未知键是 strip，不报错 ⇒ 你只会看到原文照常显示在
//      block 消息里，没有任何东西会红）。本机 claude.exe 字节级取证（2026-08-08）：
//        · 输出 schema：`Se({hookEventName:xt("UserPromptSubmit"), additionalContext:N().optional(),
//          sessionTitle:N().optional(), suppressOriginalPrompt:Bt().describe('When decision is
//          "block", omit the original prompt from the block message').optional()})`
//        · 取值处：`case "UserPromptSubmit": u.additionalContext=e.hookSpecificOutput.additionalContext,
//          u.sessionTitle=e.hookSpecificOutput.sessionTitle,
//          u.suppressOriginalPrompt=e.hookSpecificOutput.suppressOriginalPrompt; break;`
//        · 消费处：`let q = D.suppressOriginalPrompt ? U : \`${U}\n\nOriginal prompt: ${I}\`;`
//      而 `decision` / `reason` 确在顶层（同一份 schema 的基对象里：
//      `decision:Nr(["approve","block"]).optional(), reason:N().optional()`）。
//      （⚠ 上面「输出 schema」那行引文是 exe 内两处 schema 片段的拼合、非单处原文——
//      对抗官逐字核过两处判据一致，结论成立；引用时别当成单一偏移的原文去找。）
//      ⇒ 本 hook 按 exe 写：两个字段分处两层。**盘上文件与文档冲突时以实测为准**，
//      这一处的差异已写进交付，别按文档那张表回改。
//   ✅ **多 hook 同事件并存时 block 照样生效**（2026-08-08 前提批真链路实测；本仓
//      UserPromptSubmit 上已有 dao-cn-title 与 dao-rhythm 两条）。三条结论的证据强度
//      不同，拆开标注（对抗官核过；log 已归档 issue #184 评论——`_tmp` 会被清）：
//      · **block 之后 cron 照常调度** —— `_tmp/premise-184/upsubmit.log` 直接支撑
//        （两轮探针相隔 60s 都留痕）；
//      · block 真拦（探针轮会话侧零出现）—— 主会话当事观察（UI 现场 blocked 提示 ×2 +
//        AI 侧零收到），transcript 扫描输出未落盘，强度低于 log 一档；
//      · 非探针 prompt 零误伤 —— 同 log 第 3 行（用户消息走完 hook 链且正常进会话）。
//      实验体 premise-hook.js 已按 spec 用毕即删，该实测无法原样重跑（宿主协议不变则结论不失效）。
//   ✅ 本事件的宿主超时上限被降到 **30 秒**（`hooks.md:415`），远高于本 hook 的开销
//      （非探针轮只读一次 stdin + 跑一条锚定正则，**零磁盘 I/O**）。
//
// ── 判据写得极窄，两侧代价不对称，故刻意偏保守 ──────────────────────────────
// 判据 = **trim 之后以 `[dao-probe]` 开头**。三点照直写：
//   ① **为什么 trim**：与同仓既有的 `[dao-heartbeat]` 签名（`dao-rhythm.js` WAKEUP /
//      `dao-hard-gates.js` G6）**逐字同一套写法**，让帅与用户只记一套心智模型；
//      放宽的只有前导空白这一格。
//   ② **误伤面**：一条真由用户敲出的、**恰好以 `[dao-probe]` 开头**的消息会被拦。可接受，
//      因为这个 token 只为本机制存在；且拦下时用户**看得见 reason**（block 消息会显示给用户），
//      再敲一遍即可，热加载摘除 hook 就地止血。
//   ③ **反方向的代价小得多**：签名对不上就**放行**（那一轮白跑一次探针，只花几句话额度）。
//      ⇒ 两侧不对称 ⇒ 判据往「宁可漏拦、绝不误拦」那一侧写。
// 其余 prompt 一律**零干预**：不输出一个字节、不碰磁盘、不写日志（写日志就等于把每条用户
// 消息都记一遍 —— 那是本 hook 绝不做的事）。
//
// ── fail-open 铁律（这个 hook 的 fail-open 方向特别要紧）────────────────────
// 本 hook 是**唯一一个会拦下用户消息的 dao hook**，所以它的每一条失败路径都必须倒向**放行**：
//   · stdin 坏了 ⇒ 放行（连 prompt 都读不出来，就更没资格判它是不是探针）
//   · 标记文件读不动 / 不是合法 JSON ⇒ **放行**（宁可多跑一轮探针，不可能因为一个坏文件
//     把探针链永久拦死 —— 那会让限流恢复彻底失效且无人知晓）
//   · 本 hook 自己崩了 ⇒ 最外层 catch 里 exit 0、零输出 ⇒ 宿主按「hook 没意见」放行
//     🔴 **这一条在 2026-08-08 之前是真空锚**（#190 第 3 条，双官各自独立证实）：注入点全在
//     `main()` 内层 try 里 ⇒ 走不到外层 ⇒ 把这一行改成 fail-closed 全套断言零红。
//     现已有 `outer` 注入相位 + 对应断言把它钉住（见 `S.maybeForceError("outer")` 那一处）。
// ⇒ **本 hook 自身的失效态都退化成「探针照跑」，也就是退化成没有本 hook 之前的样子。**
//    ⚠ 这句只在单 hook 层成立（对抗官 2026-08-08 证伪了原「所有失效态」措辞）：联合机制层
//    是 fail-closed —— 哨兵不响（其余 8 种 error / 哨兵自身失效）⇒ 无标记 ⇒ 本 hook 把每轮
//    探针拦死，症状与「一直没限流」逐字节相同。
//    ~~deadman 缺口挂 issue #190 第 1 条。~~ **用户 2026-08-08 拍板：deadman 兜底轮刻意不做**
//    （场景归因——这个机制服务的是无人值守时段，而检测结果只有人在场才消费得动；人在场那一刻
//    不用体检也发现得了限流。失效下界 = 未装本机制的原始态，不是新灾难）。**重开条件只有一条**：
//    `_tmp/rate-limit-sentinel/fired.log` 攒出真实限流样本后，若发现哨兵漏记 ≥1 例
//    ⇒ 那时讨论的是「哨兵为什么漏」，不是「要不要保险」。⇒ **别再往这里加兜底轮。**
//
// ── 全域分布（建护栏前先摸分布）──────────────────────────────────────────────
// 本 hook 上线前，本仓 UserPromptSubmit 上有 2 条（`dao-cn-title.js` timeout 12 /
// `dao-rhythm.js` timeout 10），**两条都只做注入、没有任何一条会 block**
// ⇒ 「UserPromptSubmit 上出现第一个 block 者」这件事本身是新的，前提批因此专门实测了
// 「多 hook 并存时一个 block 是否即拦全轮」（结论：拦）。
//
// ── 输出面不在扫描面内（守卫铁律③）──────────────────────────────────────────
// 扫描面 = stdin 里的 prompt；产出 = stdout 的单帧 JSON + `<仓根>/_tmp/probe-gate/` 下的日志。
// 日志永远不会被当成 prompt 读回来 ⇒ 报告不可能落进自己的扫描面。
//
// 回归网：tests/probe-gate.tests.js
// 真相源：windsurf-dao/ccswitch/hooks/dao-probe-gate.js
// 注册（用户/帅动作，本文件不代做）：settings.json → hooks.UserPromptSubmit（与既有两条同组）

"use strict";

const fs = require("fs");
const path = require("path");
const { createHookScaffold } = require("../lib/hook-selfcheck.js");

const SIGNATURE = "[dao-probe-gate v1]";
const EVENT = "UserPromptSubmit";
const ROOT = path.resolve(__dirname, "..", ".."); // 本文件在 <root>/ccswitch/hooks/

// 与 dao-rate-limit-sentinel.js **同一个** env 名、同一个默认路径。
// 两边任一侧改了这一行而另一侧没跟，症状是「哨兵写了、闸门永远查不到」——
// 两边各自的日志都正常。回归网 tests/probe-gate.tests.js §跨文件一致性 钉住这一格。
const MARKER_PATH = process.env.DAO_RATE_LIMIT_MARKER || path.join(ROOT, "_tmp", "rate-limit-interrupt.json");

// 探针签名：**锚定在开头**（`^`），大小写敏感，方括号必须闭合。判据的宽窄见头注。
const PROBE_SIG = /^\[dao-probe\]/;

// ── 标记陈旧判据（issue #190 第 4 条最后一格）────────────────────────────────
// 标记文件原先**没有任何时效概念**：一条三个月前的中断标记与三分钟前的那条，
// 对本 hook 完全等价 ⇒ 探针轮会被放行去「接手」一件早就自己好了的事，而它看不出区别。
// 判据 = `at + reset_estimate_s + 余量` 已经过去即**陈旧**（`reset_estimate_s` 为 null 时按 0 计，
// 于是退化成「距 at 超过余量」）。
//
// 🔴 **陈旧只改分类、不改放行判定，这一格刻意为之**：本 hook 是全仓唯一会拦下用户消息的 hook，
// 而「陈旧即拦」会把它往 fail-closed 那一侧推 —— 那正是 #190 第 1 条整张单子在警告的方向
// （标记读不出来都要放行，凭什么标记旧了反倒拦）。⇒ 陈旧的产出是**一句话与一个日志字段**，
// 给消费者（探针轮 / 看 fired.log 的人）判断用，判定仍是放行。
//
// 调参三问（余量取 24 小时，**用户 2026-08-09 #70 追认** —— 阈值取值属判断档，此前是 AI 自定初值，现已转正为拍过板的基线，再动需新理由）：
//   ① 改小（如 1 小时）会怎样 ⇒ 「会话关着过了一夜」这种完全正常的情形会被标陈旧，
//      而探针 cron 是 session 级、会话没开就不跑 ⇒ 制造的是噪音，且噪音会训练人无视这句话。
//   ② 当前值够不够 ⇒ 限流窗本身已经计入（`reset_estimate_s`），余量只需覆盖
//      「没人值守到有人回来」这段，24 小时覆盖一整夜加一个工作日。
//   ③ 24 小时到「够用下界（一个探针周期 20 分钟）」之间那段有无真实需求 ⇒ 有，过夜/出门半天
//      都住在那一段里，故不取更小。上界侧同理不取更大：取一周会让「探针链断了整周」迟迟不现形。
const STALE_GRACE_S = 24 * 3600;

/**
 * 判一份标记是否已陈旧。
 * @returns {{stale:boolean, overdue_s:number|null, why:string|null}}
 *   `at` 解析不出来 ⇒ **不判陈旧**（`stale:false` + why），不是判成陈旧：
 *   「读不出时间」与「时间已经过去」是两件事，把前者归进后者就是替未知下结论。
 */
function markerStaleness(doc, nowMs) {
  const at = Date.parse(doc && doc.at);
  if (!Number.isFinite(at)) return { stale: false, overdue_s: null, why: "标记里的 at 解析不出来" };
  const rawReset = doc && doc.reset_estimate_s;
  const reset = rawReset == null || !Number.isFinite(Number(rawReset)) ? 0 : Number(rawReset);
  const overdue = Math.round((Number(nowMs) - (at + (reset + STALE_GRACE_S) * 1000)) / 1000);
  return { stale: overdue > 0, overdue_s: overdue, why: null };
}

// 短文案是用户 2026-08-08 拍板：block 提示宿主必然渲染在终端（reason 无法静默），
// 20 分钟档（2026-08-09 拍板再降频）下每天最多 72 条 —— 每条只准占半行。签名保留（误伤时要认得出是谁拦的）。
const BLOCK_REASON = `${SIGNATURE} 无中断·已拦（#184）`;

const S = createHookScaffold({
  name: "dao-probe-gate",
  // 与哨兵同理：测试攒自己的 fired.log，不掺进生产那份（那份是「拦了多少轮/放行了几轮」的
  // 观测数据，验收判据③要从它确认 block 真的发生过）。
  stateSubdir: process.env.DAO_PROBE_GATE_STATE_SUBDIR || "probe-gate",
  failTail: "本轮探针没有被判定，按放行处理（退化成没有本 hook 之前的样子）",
  forceErrorEnv: "DAO_PROBE_GATE_FORCE_ERROR",
  selfTestEnv: "DAO_PROBE_GATE_SELFTEST",
});

/**
 * 读中断标记。四态，**刻意分得开**：
 *   {state:"none"}          标记不存在（父目录健康）⇒ 该拦
 *   {state:"ok", …}         标记存在且是合法 JSON ⇒ 该放行并注入
 *   {state:"bad", …}        标记存在但读不动/不是合法 JSON ⇒ **放行**（fail-open），并留痕
 *   {state:"infra-broken"}  标记父目录本身不可用 ⇒ **放行**（fail-open），并留痕（#201-③）
 * 把 "none" 与 "bad"/"infra-broken" 合流成一个是最容易犯的错：那会让一个写坏的标记文件
 * 或一个坏掉的父目录把探针链永久拦死，而症状与「一直没限流」逐字节相同。
 *
 * ── #201-③（用户 2026-08-09 拍板：放行并报异常）─────────────────────────────
 * 标记父目录被换成普通文件、或权限/磁盘异常时，`fs.readFileSync(MARKER_PATH)` 抛出的
 * errno **与「标记真的还没写过」不可区分**：Windows 上 libuv 把两者都映射成 ENOENT
 * （POSIX 一般给 ENOTDIR，这里两种都收，不靠 errno 本身分流）。此前的行为是把两者都判成
 * "none" ⇒ **闸门照常拦探针**——那正是「基础设施坏了」被误判成「没有中断」的那一格。
 * 现在 ENOENT/ENOTDIR 命中时**额外探一次父目录本身**（`isHealthyDir`，与 `readFileSync`
 * 完全独立的第二次探测，不复用它的 errno）：
 * ~~父目录是真目录 ⇒ 维持 "none"；父目录不是（不存在/是文件/统计不出来）⇒ 判 "infra-broken"~~
 * **订正（PR #227 对抗验证官 F1 坐实：这句原文与下面 `isHealthyDir`（:216-224）的代码、
 * 与代码本身做的事恰好相反）**：`statSync` 抛异常（父目录**不存在**，或权限/磁盘等原因
 * **统计不出来**）⇒ `isHealthyDir` 判「健康」（`true`）⇒ 维持 "none"——这是正常态，本机制
 * 第一次真限流之前这条子路径本来就没建过，不是坏；只有 `statSync` 能成功但拿到的**不是目录**
 * （被换成了普通文件等）⇒ 才判「不健康」（`false`）⇒ 判 "infra-broken"，放行并在
 * `additionalContext` 里注入一行异常说明，指明修法。三个字面里只有「是文件」对，
 * 「不存在」「统计不出来」两个原是判反了——照这句改代码就是把当初翻了 16 条测试的那个坑
 * 原样复现一遍。
 */
function readMarker() {
  let text;
  try {
    text = fs.readFileSync(MARKER_PATH, "utf8");
  } catch (e) {
    if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) {
      const dir = path.dirname(MARKER_PATH);
      if (!isHealthyDir(dir)) {
        return { state: "infra-broken", why: `标记父目录不可用（${dir}）：${e.message}` };
      }
      return { state: "none" };
    }
    return { state: "bad", why: `读不动（${e && e.message}）` };
  }
  try {
    const doc = JSON.parse(text);
    if (!doc || typeof doc !== "object") throw new Error("标记内容不是对象");
    return { state: "ok", doc, text };
  } catch (e) {
    return { state: "bad", why: `不是合法 JSON（${e && e.message}）`, text };
  }
}

// 父目录本身健不健康：**独立于上面的 readFileSync**——不复用它的 errno，因为正是那个
// errno 分不清「没写过」与「父目录坏了」（守卫不能复用被守对象的解析逻辑）。
// 🔴 两态要分得开，别把它们合成一个「statSync 抛不抛」：
//   ㈠ 目录压根不存在（`statSync` 抛 ENOENT）—— 这是**正常态**，本机制第一次真限流
//      之前，`_tmp` 下这个子路径本来就没被建过（哨兵写标记时才 `mkdirSync(recursive)`）。
//      判它「不健康」会把每一次「从未限流过」都误判成「基础设施坏了」——这正是本条要防的
//      那类误判的镜像形态，故这里判 `true`（健康）。
//   ㈡ 目录存在但不是目录（是文件 / 其他节点类型）—— 这才是真正坏了，判 `false`。
// 只查**直接父目录**这一层：更深的祖先坏掉（如 `_tmp` 本身之上再套一层坏节点）不在本次
// 判据射程内，与本批要治的具体场景（`_tmp` 或其直接子目录被换成文件）保持同一粒度。
function isHealthyDir(dir) {
  let st;
  try {
    st = fs.statSync(dir);
  } catch (_) {
    return true; // 还没被建过 —— 正常态，不是坏
  }
  return st.isDirectory();
}

// 单帧协议：stdout 只写一次（写两次 = 两个拼接的 JSON = 宿主解析失败 = 本次输出全丢）。
// 由脚手架的 emit 保证幂等。
function emitBlock() {
  S.emit({
    decision: "block",
    reason: BLOCK_REASON,
    // 🔴 suppressOriginalPrompt 必须在这一层，理由与 exe 取证见头注（文档那张表会把人带到顶层）
    hookSpecificOutput: { hookEventName: EVENT, suppressOriginalPrompt: true },
  });
}

function emitAllow(context) {
  if (context == null) return; // 零干预：一个字节都不写
  S.emit({ hookSpecificOutput: { hookEventName: EVENT, additionalContext: context } });
}

// `stale` 由调用方**算好了传进来**，本函数不自己再算一遍。
// 🔴 这不是风格问题：首版让 `contextOf` 自己调 `markerStaleness`，于是同一个判断有**两个求值点**
// （一个喂心跳、一个喂注入文案）—— mutation 实测当场逮到：把喂心跳那个改成恒 null，
// 注入文案里的陈旧提示**照旧出现**。两个求值点意味着两个漂移面，也意味着任何一个 mutation
// 都只打得到一半，而红报文看起来像是「判据没坏」。⇒ 算一次，传下去。
function contextOf(marker, stale) {
  if (marker.state === "ok") {
    const staleNote = stale && stale.stale
      ? `\n⚠ **这个标记已经陈旧**（按 at + reset_estimate_s + ${STALE_GRACE_S}s 余量算，已过期 ` +
        `${stale.overdue_s}s ≈ ${(stale.overdue_s / 3600).toFixed(1)} 小时）—— 那次中断大概早就自己恢复了、` +
        "只是没人接手过（或探针链断过一段）。**本轮仍然放行**（陈旧只改分类不改判定），" +
        "但接手前先确认这活是不是已经不存在了；若确认无事，删掉标记即可。"
      : "";
    return (
      `${SIGNATURE} 查到限流中断标记 —— 本轮探针放行，你就是来接手它的。\n` +
      `标记文件：${MARKER_PATH}\n` +
      `标记全文（哨兵 dao-rate-limit-sentinel 在限流瞬间写下）：\n${JSON.stringify(marker.doc, null, 2)}\n` +
      "⚠ 接手前先删掉这个标记文件，否则下一轮探针会被再放行一次、重复接手同一件事。" +
      "（`reset_estimate_s` 为 null 只表示报错文本里没解析出重置时间，不表示没限流过。）" +
      staleNote
    );
  }
  if (marker.state === "infra-broken") {
    // #201-③：这不是「没有中断」，是基础设施本身坏了——放行 + 指明修法，不许静默拦下用户消息。
    // 🔴 `marker.why` 本身已经带了「标记父目录不可用（${dir}）：」这段前缀（见 readMarker），
    // 这里不再重复套一层同样的话——PR #227 对抗验证官 F2 实测坐实：套两层会注入
    // 「标记父目录不可用（标记父目录不可用（<dir>）：ENOENT…）」这种双重嵌套。
    return (
      `${SIGNATURE} ⚠ ${marker.why} —— 这不是「没有中断」，是基础设施坏了，` +
      "本轮先放行（#201-③，用户 2026-08-09 拍板：宁可多跑一轮探针，也不能让一个坏掉的目录把探针链永久拦死）。\n" +
      "修法：确认该目录没有被误换成普通文件、权限/磁盘是否正常；修好后下一轮会恢复正常判定。"
    );
  }
  // bad：放行但把「为什么这一轮是放行的」说清楚，否则探针轮会以为真有活要接
  return (
    `${SIGNATURE} 中断标记存在但读不出来（${marker.why}）—— 按 fail-open 放行本轮探针。\n` +
    `标记文件：${MARKER_PATH}\n` +
    "⚠ 这**不构成**「刚被限流打断」的证据：先去看那个文件本身坏在哪，再判断要不要接手。"
  );
}

function selfcheck() {
  S.runSelfcheckCli({
    event: EVENT,
    scriptName: "dao-probe-gate.js",
    // UserPromptSubmit 侧本仓既有两条都不写 matcher（空 = 全部）。空或 * 才算覆盖：
    // 写了别的 matcher 就意味着某些 prompt 走不到本 hook，而探针轮恰好可能在那一批里。
    covers: (m) => m === "" || m === "*",
    matcherLabel: (m) => (m === "" ? "(空=全部 prompt)" : m),
    coversFailNote: " ⇒ 本事件本仓既有注册都不写 matcher；写了就有 prompt 走不到本 hook，探针轮可能正在那一批里",
    logPath: S.firedLog,
    missNote: "matcher",
    describeLast: (l) => `判定=${l.decision} · 标记=${l.marker_state}`,
    staleDays: 7,
    // ⚠ ~~「探针 cron 每 5 分钟一轮」~~ **订正（2026-08-08）**：用户当天已拍板降到 **15 分钟档**
    // （同一文件 `BLOCK_REASON` 那段注释记的就是这个数），生产日志里相邻两轮也确是 15 分钟。
    // **再订正（2026-08-09）**：用户拍板再降到 **20 分钟档**（cron `7-47/20`），下次开窗重建按这个数。
    // 这一句会**印在 --selfcheck 的输出里给人看**，写着一个已经不成立的频率就是在盘上撒谎。
    // 刻意**不**把频率写死成判据（`staleDays` 才是判据）：档位是用户随时可调的，正文只说「本该在长」。
    staleNote: (d) =>
      `✗ 末次真实触发在 ${d} 天前 —— 探针 cron 是低频轮询（当前 20 分钟档），这条日志本该每天都在长。` +
      "长期不动说明探针 cron 没在跑（会话重开会清掉 session 级 cron），或本 hook 的注册掉了。",
    logReadFailLabel: "读取心跳日志失败",
    // ③ 留痕域可写性（#190 第 2 条）。本 hook 只有一个域 —— 它的承重物是**标记文件**
    // （由哨兵写、住在 `<仓根>/_tmp`），而那个域坏掉的后果在本 hook 这一侧是
    // 「fired.log 记不下来」而已；标记读不出来的那一路已经 fail-open 放行了。
    // 🔑 **跑 `--selfcheck` 要跑在「注册指向的那棵树」上**：第②③段读的都是**本文件所在仓根**的
    // `_tmp/`，而生产日志攒在注册串指的那个仓根里。在 worktree / 副本里跑 ⇒ **恒报 0 条**，
    // 与「从未被触发过」逐字节相同（PR #196 对抗官先踩了这一脚，回主仓才翻出真实记录）。
    probeDirs: [
      { label: "留痕域（<仓根>/_tmp）", dir: S.stateDir,
        failNote: "（验收判据③「从 hook 日志确认 block 真发生过」因此拿不到证据）" },
    ],
  });
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
    // 读不出 prompt 就判不了它是不是探针 ⇒ 放行。**不写 fired.log**（这不是一次探针判定），
    // 但要留 errors.log —— 否则「宿主协议变了」这种事会一路静默。
    S.appendErrorLog(`[dao-probe-gate] 解析 stdin 失败：${inputErr && inputErr.message}`, inputErr);
    process.exit(0);
  }

  // ── 外层注入相位（issue #190 第 3 条）──────────────────────────────────────
  // 这一行**刻意不在任何 `try` 里**：它抛出的异常只能被文件末尾那个最外层 catch 兜住。
  // 在它之前，本文件全部注入点都在上面那个内层 try 里 ⇒ **最外层 catch 是真空锚**：
  // 头注自称「本 hook 最要紧的一行」，而把它改成 fail-closed（emit block / exit 2）
  // 全套断言零红 —— 双官各自独立证实过（#190 第 3 条）。回归网见 tests 的「外层 catch」节。
  // 📌 它放在**签名判据之前**：这样它同时覆盖「非探针消息」那条零输出路径 —— 那条路才是
  //    每一条用户消息都走的路，也是「闸门崩了会不会吞用户消息」真正要问的那一格。
  S.maybeForceError("outer");

  const prompt = String(input.prompt == null ? "" : input.prompt);
  if (!PROBE_SIG.test(prompt.trim())) {
    // ── 非探针：零输出、零磁盘、零留痕 ──────────────────────────────────────
    // 这条路径覆盖**每一条用户消息**，所以它必须什么都不做。往这里加任何一次写盘，
    // 都等于给每条用户消息记一笔账。
    process.exit(0);
  }

  const marker = readMarker();
  const decision = marker.state === "none" ? "block" : "allow";
  const nowMs = Date.now();
  // 陈旧只对 state="ok" 有意义（"bad" 读不出内容、"none" 没有内容）；两者一律记 null，
  // **不记 false** —— `false` 会被读成「查过了、不陈旧」，而实际是「压根没得查」。
  const stale = marker.state === "ok" ? markerStaleness(marker.doc, nowMs) : null;

  S.heartbeat({
    at: new Date(nowMs).toISOString(),
    synthetic: S.isSynthetic(input),
    session_id: input.session_id || null,
    decision,
    marker_state: marker.state,
    marker_why: marker.why || null,
    marker_at: marker.state === "ok" ? marker.doc.at || null : null,
    marker_stale: stale ? stale.stale : null,
    marker_overdue_s: stale ? stale.overdue_s : null,
    prompt_head: prompt.trim().slice(0, 60),
  });

  if (marker.state === "bad" || marker.state === "infra-broken") {
    const label = marker.state === "bad" ? "中断标记读不出来" : "标记父目录不可用";
    S.appendErrorLog(`[dao-probe-gate] ${label}（${MARKER_PATH}）：${marker.why}`, null);
  }

  if (decision === "block") emitBlock();
  else emitAllow(contextOf(marker, stale));   // 陈旧算一次、传下去（两个求值点的坑见 contextOf 头注）
  process.exit(0);
}

if (require.main === module) {
  if (process.argv.includes("--selfcheck")) {
    selfcheck();
  } else {
    try {
      main();
    } catch (e) {
      // 最外层：**零输出 + exit 0** ⇒ 宿主按「hook 没意见」放行。
      // 这一条是本 hook 最要紧的一行：它保证「闸门坏了」永远不会变成「用户消息被吞」。
      const msg = `[dao-probe-gate] 未捕获异常：${e && e.message}`;
      try { process.stderr.write(msg + "\n"); } catch (_) {}
      try { S.appendErrorLog(msg, e); } catch (_) {}
      process.exit(0);
    }
  }
}

// ── 导出面：**逐项写明谁在消费**（issue #190 第 4 条点名的那一格）────────────────
// 入库时这一行是**全库零消费**：没有任何测试或脚本 require 过它，而「没人用」与
// 「留着给将来单验」在代码里长得一样。现在逐项点名 —— **有消费方的与没有的分开写**，
// 别把「注明」变成另一个笃定断言（本注释第一版就把 PROBE_SIG / SIGNATURE 写成了「有人消费」，
// 而实测那两个仍是 0；那正是它要治的病在写它的人身上重演了一遍）：
//   **有程序化消费方**
//   · `MARKER_PATH`      —— `tests/rate-limit-sentinel.tests.js` 的跨文件**运行期**契约断言
//                           （两个 hook 各自 spawn 取运行期真值比对；文本比对对「改了 ROOT 算法」
//                           这一形态失明 —— 那一格实测过，只有这个导出验得到）
//   · `markerStaleness`  —— `tests/probe-gate.tests.js` 陈旧判据单元节（界上 / 界外 / 未来时钟 /
//                           `at` 坏，这些点端到端造不出来）
//   · `STALE_GRACE_S`    —— 同上（断言它是正数，且让测试不必把那个数字抄一遍）
//   **无程序化消费方（N=0，照直写、不报百分比）**
//   · `PROBE_SIG`        —— 端到端那 13 条负控是 spawn 进程测的，**没有 require 这个正则**
//   · `SIGNATURE`        —— 测试里断言的是字面串，没走这个导出
//   · `readMarker`       —— 三态判据的唯一函数出口
//   三个都**刻意保留**：删了以后想单验就得改被测文件本身。
//   ⚠ 这份清单**没有任何机器在核**（试过按「导出名是否出现在某处 require 解构里」做闸，
//     那是文本启发式、两个方向都有反例）⇒ 它靠读的人负责，与本仓其他手维护枚举同一个弱点。
module.exports = { PROBE_SIG, MARKER_PATH, SIGNATURE, readMarker, markerStaleness, STALE_GRACE_S };
