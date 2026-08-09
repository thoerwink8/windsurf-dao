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
// ~~反过来说：**这个挂载点此前从未在本机被触发过一次**，故「它到底会不会响」在真限流发生前
// 只有文档与 exe 取证，没有实况——`--selfcheck` 的第②段（真实心跳）就是等那一刻的。~~
// 🟢 **2026-08-08 那一刻到了，这段话已作废**（PR #196 对抗官从生产日志翻出来的，不是推测）：
// 主仓 `_tmp/rate-limit-sentinel/fired.log` 有 **2 条 `synthetic:false`** 的真实触发
// （`09:10:32.782Z` / `09:10:33.188Z`，同一 session `92f3e632`），error=`rate_limit`，
// **中文拼车式解析命中**（`reset_parse:"cn-carpool"`，`reset_estimate_s:10200` ＝原文「约 2 小时
// 50 分钟后重置」）。⇒ 三件事同时被坐实：①宿主真的会在限流时调 StopFailure ②payload 的
// `error` 值域与本 hook 的判据对得上 ③**中文式那条真实语料背书的正则真的在生产上命中过一次**
// （英文式仍未命中过，头注上面那段关于「英文式判别力只有合成语料」的话**依旧成立，别顺手一起划掉**）。
//
// ── fail-open 铁律 ───────────────────────────────────────────────────────────
// 宿主对 `command` 型 hook 的失效态本来就是 fail-open（`[#守-宿主失效态]`），而本事件
// 更彻底：输出与退出码都被忽略。⇒ 本 hook **任何异常一律 exit 0 + 写 errors.log**，
// 永不阻塞宿主。**它唯一的失败形态是「什么都没记下来」，而那与「本次没有限流」长得一样**
// —— 这正是三重留痕（stderr + errors.log + 心跳）存在的理由。
// ⚠ 对抗实测（2026-08-08）：「三重」并不构成三个独立域——errors.log 与心跳同住
// `<仓根>/_tmp`（与标记文件同域），stderr 在本事件下被宿主直接丢弃 ⇒ 仓根 `_tmp` 坏掉
// 即全部通道同时哑掉且 exit 0。~~单点加固挂 issue #190 第 2 条。~~
// **加固已落地（#190 第 2 条，两件）**：
//   ① **镜像域**：每条记录另追加一份到 `MIRROR_LOG`（`~/.claude/dao-state/…`，**出 `_tmp` 域**）
//      —— 仓根 `_tmp` 整个坏掉时它照写。它是「限流真的发生过」这条事实的**第二个物理落点**，
//      而 #190 第 1 条的重开条件（哨兵有没有漏记）就要靠这类耐久样本回答。
//   ② **`--selfcheck` 第③段**：对两个域各**真写一次再删**（不是「目录存在吗」——`_tmp` 被占成
//      普通文件时后者答「不存在」，与「还没建过」不可区分），写不进去当场 ✗ 并说明它会污染第②段。
//      🔑 **跑它要跑在「注册指向的那棵树」上**：`--selfcheck` 的第②③段读的都是**本文件所在仓根**
//      的 `_tmp/`，而生产日志攒在注册串指的那个仓根里。在 worktree / 副本里跑 ⇒ **恒报 0 条**，
//      而那与「从未被触发过」逐字节相同。（PR #196 的对抗官先踩了这一脚，才回主仓翻出那 2 条真实记录。）
// **照直写它还不了的那一半**：两个域的**历史对账**（镜像比 `_tmp` 多几条 ⇒ 那侧丢过记录）
// 本批**没做**。~~那个数字只有攒出真实限流样本之后才有消费者，而此刻是 0 条~~
// **理由订正（2026-08-08，PR #196 对抗官用生产日志推翻了原理由的前提）**：主域此刻**不是 0 条，
// 是 2 条真实样本**（见上面那段）。真正还不了的是另一格 —— **镜像通道本 PR 才引入，镜像侧仍是
// 0 条**，而对账要的是两侧都有数据才比得出差额。⇒ 欠的不是「等第一个样本」，是「等镜像也攒到
// 样本、且两侧覆盖同一段时间」。欠账记在 PR 未尽处；判据不变，变的是它还差什么。
//
// ── 输出面不在扫描面内（守卫铁律③）──────────────────────────────────────────
// 本 hook 的输入是 stdin 的 payload，产出落在 `<仓根>/_tmp/`（已 gitignore）与
// `~/.claude/dao-state/`（在仓外，git 看不见）。两者与扫描面都没有交集
// ⇒ 报告不可能被自己重新读进来。**镜像域也不进 git**：它是本机运行期状态，不是部署资产。
// ~~（换机自动重建，故 NEW-MACHINE.md 无需登记）~~
// **订正（2026-08-08，PR #196 对抗官指出它与同一个 PR 自己的改动自相矛盾）**：这句话在写下的
// 同一批里就已经不成立 —— `NEW-MACHINE.md` **§3「换机会变的东西」那张表里已经有它一行**
// （「hook 本机状态目录 / 不随换机走 / 无需处理」）。⇒ 正确说法是：**它不需要「恢复步骤」，
// 但需要一行「换机后它是空的」的登记**，两者不是一回事。**别照原句去删 NEW-MACHINE 那一行。**
//
// ── deaths_24h：最近 24h 限流死亡计数（issue #70 自适应并发批，笔①：哨兵信号增强）───
// 用户 2026-08-09 拍板「自适应并发」——水位判据（`ccswitch/rules/dao-longwindow.md`
// §心跳对账节·丙㈣）要读到「最近死过几次」而不是只有「现在有没有标记」这一个二值信号。
// 判据**不新造存储**：直接数 `S.firedLog` 里既有的 `marked:true` 行（那本来就是「写标记
// 成功」的判据），24 小时窗与 `dao-probe-gate.js` 的 `STALE_GRACE_S`（同样取 24h）是两件
// 独立的事——那边问「这条标记多旧」，这里问「这台机器过去一天死了几次」，只是恰好同一个
// 窗口长度，别读成共享同一个判据。**含本次**：这一刻正在写的这次死亡本身也算一次
// ——语义是「连这次在内，过去 24h 我死了几次」，不是「这次之前死过几次」。
// ~~读失败时记 `null` 不记 `0`：0（真的零次）与「读不出来」必须分得开，同 `reset_estimate_s`
// 的判据同一路数。~~
// **订正（2026-08-09，PR #230 对抗官 12 探针实测证伪）**：上面那句是过度概括的旗舰宣称。
// 实测**只有一种「读失败」真的走得到 `null`**——`readFileSync` 本身抛异常（如 fired.log
// 路径被占成目录）。**坏行（整行非法 JSON）与坏 `at`（缺失/非法时间戳）不算这种「读失败」**：
// `readJsonlRecords → parseJsonl` 的设计是坏行跳过而非抛（`ccswitch/lib/hook-selfcheck.js:68`
// 头注「日志是旁证，一行写坏了不该让整份日志不可读」——对心跳判活是对的，对本函数的计数语义
// 恰好是反的），这类记录会被静默当「不是死亡」处理，与「真的零次」在输出上不可区分，
// **报成 0，不是 null**。这一格此前**没有任何断言在守**（mutation：把 catch 里的
// `return null` 改成 `return 0`，既有 165 条断言零反对）；现已补上零守护断言，见下方
// `countDeaths24h` 定义处「M5' 零守护断言」测试块与 tests/rate-limit-sentinel.tests.js。
// 生产 fired.log 是否真会出现坏行/坏 `at` 未经真实样本核实，属已知挂账，见 issue 追踪。
//
// ── 三处待补强（issue #236，PR #230 对抗官 12 探针 + 17 mutation 夹击挂账）───────
// PR #230 落地当轮判据本身是对的（既有 165 条断言零反对），但对抗官证明「往错误方向
// 悄悄改一点，现有测试一条都不会红」，三处代码层缺口本批（issue #236）逐条补：
//   ① **时钟只有下界，没有上界**——伪造的未来时间戳（如 `at` 写成 10 天后甚至 9999 年）
//      此前会被永久计入且永不过期。修法：`countDeaths24h` 的窗口判据补 `t <= nowMs`
//      （见下方定义处）。验证过零阻力：补上后既有 165 条断言零反对。
//   ② **窗口长度（24h）在缩短方向没有测试兜底**——语料只覆盖到 1h 正控与 25h 负控，
//      窗口在 0~25h 之间随便改都测不出来。修法：补一条 23h 正控 + 窗口收紧 mutation，
//      见 tests/rate-limit-sentinel.tests.js「issue #236 挂账②」。
//   ③ **死亡判定不能从 `=== true` 松成 truthy**——写入侧目前永远是布尔值，属结构上的缝
//      而非当前活跃风险，此前没有断言守着这条判据不被放宽。修法：补一条 truthy-非-true
//      正控 + 放宽 mutation，见 tests/rate-limit-sentinel.tests.js「issue #236 挂账③」，
//      本条判据本身不改（`=== true` 严格判等原样保留，issue 原文对这一格「不预判优先级」，
//      故只补测试兜底、不动生产代码）。⚠ 对抗复核（PR #239 判词）实测：该兜底对
//      `=== true` → `== true`（宽松相等）这一放宽形态仍零守护——正控样本 `"true"` 恰好
//      `== true` 为 false，从该改法射程外溜走；修法（样本换 `1`，一个样本同钉 truthy 与
//      宽松相等两形态）归跟进单。
// issue 里另记了一条「文件轮转与 24h 窗口叠加时计数理论上会骤降」的边界，issue 原文
// 定性为「理论边界，不代表短期要修，不预判优先级」——本批不动它，照直挂在 issue 上。
//
// 回归网：tests/rate-limit-sentinel.tests.js
// 真相源：windsurf-dao/ccswitch/hooks/dao-rate-limit-sentinel.js
// 注册（用户/帅动作，本文件不代做）：settings.json → hooks.StopFailure，matcher "rate_limit|overloaded"

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createHookScaffold, readJsonlRecords } = require("../lib/hook-selfcheck.js");

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

// ── 镜像留痕域：**刻意不在 `<仓根>/_tmp` 里**（issue #190 第 2 条）──────────────
// 三条既有通道（errors.log / fired.log / last.json）同住 `<仓根>/_tmp/<subdir>/`，
// 第四条 stderr 在本事件下被宿主直接丢弃 ⇒ **那一个目录坏掉，四条一起哑且退出码干净**。
// 本行给出第二个物理落点：`~/.claude/dao-state/rate-limit-sentinel/fired.log`。
// 为什么落 `~/.claude` 而不是别处：①它与仓根 `_tmp` 通常在不同的盘/不同的权限域
// ②它是本机 dao 状态的既有落点（hook 自己就住在这台机器上，不依赖任何仓在不在）
// ③它在仓外 ⇒ 不进 git、不被 `_tmp` 清理动作扫到、也不落进任何守卫的扫描面。
// **它是镜像不是主产物**：写不成一律吞掉（`_tmp` 那侧照写），永不影响退出码。
//
// ── 结构性沙箱兜底（issue #201 笔 2）──────────────────────────────────────────
// 前情：这份生产落点是「真实限流实战样本」的耐久数据（#190 重开条件直接指着它），
// 此前**唯一的隔离手段是每个测试消费方各自记得传 `DAO_RATE_LIMIT_MIRROR`**——那是
// 纪律不是结构，第二个消费方忘传就静默把合成样本写进真实样本井，且看不出是假的
// （对抗官在 PR #196 复核期间自己当场踩过一次，证据在其 worktree
// `_tmp/evidence-selfinflicted-mirror.log`，已清理）。
// 改法：判据从「你有没有记得传 MIRROR」挪到「你像不像是在沙箱里跑」——
// `DAO_RATE_LIMIT_MARKER` / `DAO_RATE_LIMIT_STATE_SUBDIR` 任一个被显式覆写，就说明
// 调用方已经在把**别的**落盘面往沙箱里赶（生产调用两者都不传），这时哪怕漏传
// `DAO_RATE_LIMIT_MIRROR`，也该跟着落进沙箱旁边，而不是静默滑回生产路径。
// **这不是把纪律做没**——显式传 `DAO_RATE_LIMIT_MIRROR` 仍然优先（下面 `||` 左手边），
// 这一格只兜「忘传」那一种，两者都不传时行为与本行原有的唯一默认值逐字不变。
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

// 数最近 24h 内 `marked:true` 的行（判据与用途见文件头注「deaths_24h」段，
// 含上面 2026-08-09 订正——只有 `readFileSync` 真抛异常才落到这个 catch，
// 坏行/坏 `at` 由 `parseJsonl` 静默跳过，走不到这里，报的是 0 不是 null）。
// **不含本次**——本次这条记录要等 `S.heartbeat(rec)` 才追加进 fired.log，调用方
// 自己在 `marked` 分支里 +1（见 main()）。`readJsonlRecords` 之外逃逸出来的异常
// （如目录被占等 `readFileSync` 级故障）记 `null`，不吞成 0——这一格由下面
// 「M5' 零守护断言」测试块守着，见 tests/rate-limit-sentinel.tests.js。
// **`t <= nowMs` 上界（issue #236 挂账①，2026-08-09 补）**：只有下界 `t >= cutoff` 时，
// 一条被伪造成未来时刻（哪怕 9999 年）的 `at` 会永久算作「在窗内」——它永远 >= cutoff，
// 且没有任何东西会让它过期。上界把「未来」这个不该存在的时刻也挡在窗外，与「太旧」同判。
const DEATHS_WINDOW_MS = 24 * 3600 * 1000;
function countDeaths24h(nowMs) {
  try {
    const cutoff = nowMs - DEATHS_WINDOW_MS;
    const all = readJsonlRecords(S.firedLog);
    let n = 0;
    for (const r of all) {
      if (r && r.marked === true) {
        const t = Date.parse(r.at);
        if (Number.isFinite(t) && t >= cutoff && t <= nowMs) n++;
      }
    }
    return n;
  } catch (_) {
    return null;
  }
}

// 标记文件整份覆写（后一次限流覆盖前一次）。**幂等**：连发两次不炸、内容以最后一次为准。
// 探针接手后由探针那一轮删除它（见 dao-probe-gate.js 头注的分工），本 hook 只写不删。
function writeMarker(rec) {
  fs.mkdirSync(path.dirname(MARKER_PATH), { recursive: true });
  fs.writeFileSync(MARKER_PATH, JSON.stringify(rec, null, 2), "utf8");
}

// 镜像一条记录到 `_tmp` 域**之外**。全程吞异常：它是冗余通道，不许拖垮主路径。
// 记录内容与 `_tmp` 那份逐字段相同 + 一个 `mirror:true` 标记（读的人要分得出自己在看哪一份；
// 也让 `--selfcheck` 的第②段若哪天被指到这份日志上时，不会把镜像误当成另一次触发）。
function mirrorRecord(rec) {
  try {
    fs.mkdirSync(path.dirname(MIRROR_LOG), { recursive: true });
    fs.appendFileSync(MIRROR_LOG, JSON.stringify(Object.assign({ mirror: true }, rec)) + "\n", "utf8");
  } catch (_) { /* 镜像写不成不该拖垮主路径 —— `_tmp` 那侧照写 */ }
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
    // ③ 留痕域可写性（#190 第 2 条）。**两个域各查一次，刻意分开报**：
    // 只查一个的话，「主域坏了但镜像好着」与「两个都坏了」在输出里长得一样，
    // 而前者只丢观测精度、后者是这个 hook 彻底静默 —— 处置完全不同。
    probeDirs: [
      { label: "主域（<仓根>/_tmp）", dir: S.stateDir,
        failNote: "（fired.log / errors.log / last.json 三样都在这里 ⇒ 它坏了这三样一起哑）" },
      { label: "镜像域（出 _tmp，本机 dao 状态）", dir: path.dirname(MIRROR_LOG),
        failNote: "（这是主域坏掉时唯一还在记账的通道 ⇒ 它也坏了就真的一条都不剩了）" },
    ],
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
    const badRec = {
      at: new Date().toISOString(), synthetic: true, error: null, marked: false,
      reset_estimate_s: null, reset_parse: null, error_message: String(inputErr && inputErr.message),
    };
    S.heartbeat(badRec);
    mirrorRecord(badRec);
    process.exit(0);
  }

  // ── 外层注入相位（issue #190 第 3 条）──────────────────────────────────────
  // 这一行**刻意不在任何 `try` 里**：它抛出的异常只能被文件末尾那个最外层 catch 兜住。
  // 在它之前，本文件全部注入点都在上面那个内层 try 里 ⇒ 外层 catch 是**真空锚**
  // （把它改成 fail-closed 也没有一条断言会红）。回归网见 tests 的「外层 catch」那一节。
  S.maybeForceError("outer");

  const error = String(input.error || "unknown");
  const details = input.error_details == null ? "" : String(input.error_details);
  const lastMsg = input.last_assistant_message == null ? "" : String(input.last_assistant_message);
  const raw = `${details} ${lastMsg}`.trim().slice(0, RAW_MAX);
  const { seconds, how } = parseResetSeconds(`${details}\n${lastMsg}`, Date.now());
  const at = new Date().toISOString();
  const marked = MARKED_ERRORS.has(error);

  let markerErr = null;
  if (marked) {
    // `countDeaths24h` 读的是 fired.log **此刻已有**的行（这次死亡还没落盘），
    // 故 +1 把「正在写的这次」计进去——语义见文件头注「deaths_24h」段。
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
      S.appendErrorLog(msg, e);
    }
  }

  const rec = {
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
  };
  S.heartbeat(rec);
  // 第二个物理落点，出 `_tmp` 域（#190 第 2 条）。顺序在 heartbeat 之后：`_tmp` 那份仍是主账。
  mirrorRecord(rec);

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

// ── 导出面：**逐项写明谁在消费**（issue #190 第 4 条同型要求）──────────────────
// 「全库零消费的导出」与「为将来单验保留的缝」在代码里长得一样，故此处照直点名，
// **有消费方的与没有的分开写**（别把「注明」写成另一个笃定断言）：
//   **有程序化消费方**
//   · `parseResetSeconds` —— tests 解析式单元节（上下界与「哪一式命中」端到端验不到）
//   · `MAX_RESET_S`       —— 同上（让边界断言不必把那个数字抄一遍）
//   · `MARKER_PATH`       —— tests 的跨文件**运行期**契约断言（两个 hook 各自 spawn 取运行期真值
//                            比对；文本比对对「改了 ROOT 算法」这一形态失明 —— 实测过）
//   **无程序化消费方（N=0，照直写、不报百分比）**
//   · `MARKED_ERRORS` / `SIGNATURE` —— 测试里出现的是**同名字面串**（mutation 锚点 / 值断言），
//                            没有走这个导出；保留是因为它们是那两条判据的唯一符号出口
//   · `MIRROR_LOG`        —— 测试一律走 env 覆写口 `DAO_RATE_LIMIT_MIRROR`，不读这个默认值
//   ⚠ 这份清单**没有任何机器在核**，靠读的人负责（与本仓其他手维护枚举同一个弱点）。
module.exports = { parseResetSeconds, MARKED_ERRORS, MARKER_PATH, MIRROR_LOG, MAX_RESET_S, SIGNATURE };
