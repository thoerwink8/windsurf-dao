// dao-compact-log.js — PostCompact · 压缩可见化
//
// ── 治的是什么病 ─────────────────────────────────────────────────────────────
// always-on 规则快照按 compaction 刷新（实测延迟 ~12h，见 dao-rule-echo.js 头注），
// 但刷新时刻本身不可见——帅无从知道自己此刻的规则快照是新是旧，也无从知道
// compaction 刚发生过。本 hook 让每次 compaction 变成一个可被观测的事件。
//
// ── 已验证边界（2026-07-26，动手前先查官方文档，勿硬编未验证能力）───────────
// 查 https://code.claude.com/docs/en/hooks：
//   ① PostCompact 事件真实存在，matcher 可填 "manual"/"auto"/"*" 区分触发源
//      （字段名沿用 PreCompact 已确认的 `trigger`，PostCompact 文档未逐字给出
//      示例 JSON，本脚本按 `trigger` 优先、`source` 兜底读取，避免猜错字段名
//      导致数据丢失）。
//   ② PostCompact 在决策控制表里归类为 "None —— 无决策控制，用于日志/清理类
//      副作用"，**不支持** hookSpecificOutput.additionalContext（该字段仅
//      UserPromptSubmit/UserPromptExpansion/PostToolUse/... 等列表内可用）。
//   ③ stdout 处理规则：exit 0 时 JSON 输出仅解析"通用字段"（如 systemMessage，
//      "跨事件生效的警告消息，展示给用户"）；非 JSON 纯文本 stdout 只写调试日志、
//      不进 transcript——**唯一**让纯文本 stdout 进 transcript(可被视为上下文)
//      的例外是 UserPromptSubmit / UserPromptExpansion / SessionStart 三个事件，
//      PostCompact 不在其中。
//   故本 hook **不能**像 dao-rule-echo.js 那样把内容"回灌进模型上下文"——那是被
//   文档证实对 PostCompact 不支持的能力，硬做等于自欺（fortify-20260726 契约
//   明确要求：实测不通就降级，不许硬编未验证能力）。退而求其次的两条腿：
//     · systemMessage（JSON 输出的通用字段）——文档确认 PostCompact 可用，
//       但其可见范围止于"展示给用户"（CLI transcript UI）；这是否等价于
//       "帅在下一轮回复时能读到"未被文档逐字担保，需要一次真实 compaction
//       事后核对（本次交付无法在会话内人为触发一次真实 compaction 来验证，
//       此项显式挂账，见随交付附的说明，不在此处打包票）。
//     · 落盘日志 ~/.claude/compaction-log.jsonl —— 唯一确定生效的可见化手段，
//       不依赖任何未验证的 UI 行为，任何时刻都能 Read 核对"上次 compaction
//       距今多久、触发源是什么"。
//   因 ② ③ 之故，落盘日志是本 hook 的**主产物**（不是旁证）⇒ 写不成必须报出来，
//   故用 H.appendJsonl（向上抛）而非 H.heartbeat（吞异常）。这一分工写进了
//   ccswitch/lib/hook-selfcheck.js 头注的「有意保留的差异 ①」，勿顺手统一。
//
// ── selfcheck ────────────────────────────────────────────────────────────────
// node dao-compact-log.js --selfcheck 两路核验（同 dao-rule-echo.js 的双路精神，
// 加固层已抽为 ccswitch/lib/hook-selfcheck.js，本文件只留判据）：
//   ① settings.json 里是否真注册 PostCompact hook（读注册串）
//   ② 日志文件是否有非 synthetic 的真实触发记录（自测心跳标 synthetic，不计入
//      "已生效"判据——「文件存在/脚本能跑」≠「宿主真调用过」）。
//
// 真相源：windsurf-dao/ccswitch/hooks/dao-compact-log.js
// 自证：node tests/dao-compact-log.tests.js

const path = require("path");
const { createHookScaffold, HOME, ROOT, readJsonlRecords } = require("../lib/hook-selfcheck.js");

const LOG_PATH = path.join(HOME, ".claude", "compaction-log.jsonl");

const H = createHookScaffold({
  name: "dao-compact-log",
  stateSubdir: "compact-log",
  failTail: "本次压缩日志未记录；hook 不阻断",
  forceErrorEnv: "DAO_COMPACT_LOG_FORCE_ERROR",
  selfTestEnv: "DAO_COMPACT_LOG_SELFTEST",
});

// ── scaffold-check 死闸检测的挂载点（2026-08-09 · 机制体检报告 §二 🟡①②）──────
// 治的是什么病：`dao-scaffold-check.js`（SessionStart）是全仓维护热点第一（30 天 34
// 次维护），承载死闸检测 / always-on 预算闸 / 条款库结构闸 / per-provider 漂移检测的
// 挂载——它自己若停摆（未注册 / 崩溃 / 被宿主超时杀掉），这些检查跟着一起停，而「停了」
// 与「本轮无事可报」在盘上逐字节相同。它已经在自己那侧接了心跳
// （`_tmp/scaffold-check/fired.log`，见该文件「心跳自证」大注），但**读心跳判陈旧的人
// 不能是它自己**——那样只是把循环依赖原样保留、只是换了个身位。见
// `_tmp/mechanism-audit-20260809.md` §二 🟡「dao-scaffold-check.js」那一行。
//
// 为什么挂在这里（PostCompact / 本文件）而不是新建 hook 或挂在别的事件上：
//   · 新建 hook 要在 live + 快照 + DB 三处注册，是本仓反复点名的一笔债；
//   · UserPromptSubmit 上已有三条（cn-title / rhythm / probe-gate），且 probe-gate
//     把「非探针 prompt 零磁盘 I/O」当头等纪律——那条高频路径上再加一次 fs 读违背它；
//   · PostCompact「几乎每天」触发（上面 `staleDays: 14` 的同一条理由），且本文件**已经
//     在做磁盘 I/O、已经产出用户可见的 systemMessage**——追加一次读日志 + 一行文案，
//     边际成本趋近于零，不是新开一条高频路径。
//
// 判据：只看 `_tmp/scaffold-check/fired.log` 里 `synthetic !== true` 的最后一条记录，
// 其 `at` 距今超过 `SCAFFOLD_CHECK_STALE_DAYS` 天即报。**陈旧阈值是判断档，此处初值
// 由 AI 自定、待用户拍板**（同 dao-probe-gate.js `STALE_GRACE_S` 头注的先例）。调参三问：
//   ① 改小（如 1 天）会怎样 —— SessionStart 要「开一个新会话」才触发，用户/团队若连续
//      一两天没开新会话（长周末、专注在别的工作），会被误判陈旧而制造噪音，训练人无视
//      这句话（同本仓其余阈值论证反复点名的失败模式）；
//   ② 当前值够不够 —— 本仓是多 worktree / 多子代理协作模式，SessionStart 实际发生频率
//      大概率不低于 PostCompact（派一个官开工往往就是一次新会话）；5 天覆盖「一个长
//      周末 + 一天缓冲」，且比 PostCompact 的 14 天更紧——SessionStart 的自然发生频率
//      不该套用 compaction 的阈值，同一个数字压两个不同频率的事件只会一边过敏一边失灵
//      （`ccswitch/lib/hook-selfcheck.js` 头注已点名的同一条教训，此处照此推广）；
//   ③ 再紧一点代价是什么 —— 心跳基建本次才接上，还没有真实历史样本可供统计校准，定得
//      更紧可能在一个安静的周末就制造假警报；5 天是留了缓冲的初值，等有真实 fired.log
//      样本后可收紧或放宽，不取更极端的两侧。
const SCAFFOLD_CHECK_STATE_SUBDIR = process.env.DAO_SCAFFOLD_CHECK_STATE_SUBDIR || "scaffold-check";
const SCAFFOLD_CHECK_FIRED_LOG = path.join(ROOT, "_tmp", SCAFFOLD_CHECK_STATE_SUBDIR, "fired.log");
const SCAFFOLD_CHECK_STALE_DAYS = 5;

// 三态输出（不静默）：① 读不出/读坏 → 说读不出，不当「没事」② 从未有真实记录 → 说从未
// 触发 ③ 有记录但已过阈值 → 说陈旧并给出天数。**只有第④态（有记录且新鲜）不产出任何
// 文字**——常路零噪音，同本仓其余观察线的既有取舍。整函数不向外抛——调用方把它当「查一眼」
// 用，查不动不该拖垮本 hook 自己的主产物（压缩日志已经落盘）。
function scaffoldCheckStalenessNote() {
  let records;
  try {
    records = readJsonlRecords(SCAFFOLD_CHECK_FIRED_LOG);
  } catch (e) {
    return "⚠ scaffold-check 心跳日志读取失败（" + (e && e.message ? e.message : String(e)) +
      "）—— 这不构成「它还活着」的证据，也不构成「它死了」的证据，只是没查成：" + SCAFFOLD_CHECK_FIRED_LOG;
  }
  const real = records.filter((r) => r && r.synthetic !== true);
  if (!real.length) {
    return "⚠ scaffold-check 从未留下真实心跳记录 —— 它可能从未被宿主真实调用过（未注册 / " +
      "matcher 不覆盖），或者本条自证刚接上、还没等到下一次 SessionStart。心跳：" + SCAFFOLD_CHECK_FIRED_LOG;
  }
  const last = real[real.length - 1];
  const days = (Date.now() - Date.parse(last.at)) / 86400000;
  if (!Number.isFinite(days)) {
    // 读不出时间不等于时间已经过去（同 dao-probe-gate.js markerStaleness 的判据），
    // 本条只报异常、不替未知下陈旧结论。
    return "⚠ scaffold-check 末次心跳的 at 解析不出来（" + JSON.stringify(last.at) + "）—— " +
      "读不出时间不代表时间已经过去，本条只报异常不下陈旧结论";
  }
  if (days <= SCAFFOLD_CHECK_STALE_DAYS) return null;
  return "✗ scaffold-check 已 " + days.toFixed(1) + " 天没有真实触发（阈值 " + SCAFFOLD_CHECK_STALE_DAYS +
    " 天）—— 它是死闸检测 / always-on 预算闸 / 条款库结构闸 / per-provider 漂移检测的挂载" +
    "总线，它停了这些检查跟着一起停。核 ~/.claude/settings.json 的 SessionStart 注册是否还在，" +
    "或手动跑一次它内部调用的检查器（如 node ccswitch/scripts/check-dead-gates.mjs）确认它们本身没坏。";
}

// ── --selfcheck：查注册 + 查心跳，不看「文件是否存在」 ──────────────────────
if (process.argv.includes("--selfcheck")) {
  H.runSelfcheckCli({
    event: "PostCompact",
    scriptName: "dao-compact-log.js",
    // 无 matcher 或 "*" 视为覆盖 manual+auto 全部来源
    covers: (m) => m === "*" || m === "",
    matcherLabel: (m) => m || "(未设，视为全匹配)",
    coversFailNote: " —— 未覆盖 manual/auto 全部来源，请核对",
    logPath: LOG_PATH,
    missNote: "matcher/字段判据",
    describeLast: (last) => `trigger=${last.trigger} · session=${last.session_id}`,
    // compaction 几乎每天发生 ⇒ 14 天未见即高度可疑（比 rule-echo 的 30 天严，
    // 因为两者的自然发生频率差一个量级，同一阈值会让一边过敏、一边失灵）
    staleDays: 14,
    staleNote: (d) => `⚠ 末次真实触发距今 ${d} 天，请核 settings.json 注册是否仍生效。`,
    logReadFailLabel: "日志读取失败",
  });
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
const input = H.readStdinJson();

try {
  H.maybeForceError("build");

  // trigger 字段名沿用 PreCompact 已确认的 `trigger`（manual|auto），source 兜底
  // ——PostCompact 文档未逐字给出示例 JSON，双读法避免猜错字段名致数据静默丢失。
  const trigger = String(input.trigger || input.source || "unknown");
  const sessionId = String(input.session_id || "");
  const cwd = String(input.cwd || "");
  const transcriptPath = String(input.transcript_path || "");
  const now = new Date().toISOString();
  const synthetic = H.isSynthetic(input);

  const rec = { at: now, trigger, session_id: sessionId, cwd, transcript_path: transcriptPath, synthetic };
  H.appendJsonl(LOG_PATH, rec);

  // systemMessage 是跨事件生效的通用字段，PostCompact 文档确认支持——但其可见范围
  // 止于"展示给用户"，是否等价于模型下一轮可读未被文档担保（见头注③），措辞不打包票。
  const humanMsg =
    `【快照已刷新 · dao-compact-log】compaction 刚完成（trigger=${trigger}）@ ${now}——` +
    `always-on 规则快照已按盘上最新版重载；中途写入的条款自此可被读到` +
    `（可见范围止于展示给用户，模型侧可见性未逐字验证，落盘日志见 ${LOG_PATH}）。`;

  // scaffold-check 死闸检测的挂载点（见上方大段头注）：顺带查一眼它有没有停摆。
  // try/catch 兜底——这一段查不动不该拖垮本 hook 自己的主产物（压缩日志已经落盘）。
  let staleNote = null;
  try {
    staleNote = scaffoldCheckStalenessNote();
  } catch (e) {
    staleNote = "⚠ scaffold-check 陈旧检测自身抛错：" + (e && e.message ? e.message : String(e));
  }

  H.emit({ systemMessage: staleNote ? humanMsg + "\n" + staleNote : humanMsg });
  process.exit(0);
} catch (e) {
  H.fail("构造压缩日志记录", e);
}

// ── 注册片段（供 ~/.claude/settings.json 的 hooks.PostCompact 数组使用）───────
// 三处一致（缺一处则换机/同步后失效，同 dao-rule-echo.js 三层模型）：
//   ① live  ~/.claude/settings.json
//   ② git 快照 windsurf-dao/config-sync/common/settings.json（cc-switch DB 导出格式）
//   ③ cc-switch DB（restore.mjs --scope=settings）—— fortify-20260726 本次只动①②，
//      ③ 留一行用户动作待办（下次跑 restore 时收编，避免直接改 DB 越权）。
//
// {
//   "matcher": "*",
//   "hooks": [
//     {
//       "type": "command",
//       "command": "node \"D:/frank/windsurf-dao/ccswitch/hooks/dao-compact-log.js\"",
//       "timeout": 10
//     }
//   ]
// }
//
// 注册后核验：node ccswitch/hooks/dao-compact-log.js --selfcheck
//   预期从「✗ 未注册 / ✗ 无真实触发记录」转为「✓ 已注册 / ✓ 有真实触发记录」；
//   第二个 ✓ 需真实发生一次 compaction 才会出现（心跳只由真实调用写出）。
