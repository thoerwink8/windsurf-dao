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
const { createHookScaffold, HOME } = require("../lib/hook-selfcheck.js");

const LOG_PATH = path.join(HOME, ".claude", "compaction-log.jsonl");

const H = createHookScaffold({
  name: "dao-compact-log",
  stateSubdir: "compact-log",
  failTail: "本次压缩日志未记录；hook 不阻断",
  forceErrorEnv: "DAO_COMPACT_LOG_FORCE_ERROR",
  selfTestEnv: "DAO_COMPACT_LOG_SELFTEST",
});

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

  H.emit({ systemMessage: humanMsg });
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
