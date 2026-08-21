/**
 * go-fallback — opencode Go 通道限流/额度顶时自动切直连 DeepSeek，当前会话继续干活（issue #520）。
 *
 * 为什么需要它：
 * - opencode Go 是美元额度制（账户级共享），撞顶后 pi 对 GoUsageLimitError 这类额度耗尽错误
 *   判定为 non-retryable（pi-ai utils/retry.js 的 NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN），
 *   内置 auto-retry 直接放弃，工人当场挂掉、任务半途而废。
 * - 本扩展在 agent_end 捕获 stopReason=error 的最后一轮，把当前会话切到直连 DeepSeek 后
 *   队列一条 followUp 消息继续干活——不是重启、不是从头来（会话上下文完整保留）。
 *
 * 机制（源码核对 + 本机实测，证据见 PR 正文）：
 * - 错误分类：
 *   · hard（额度耗尽类：GoUsageLimitError / FreeUsageLimitError / Monthly usage limit /
 *     quota / billing / available balance …）→ 首次失败立即降级（pi 不会重试这类错误）。
 *   · transient（429 / rate limit / overloaded / 5xx …）→ 连续第 N 次失败才降级
 *     （默认 N=2，给 pi 内置 auto-retry 一次机会；N 可用环境变量覆盖）。
 * - 降级 = pi.setModel(直连同 id 模型) + sendUserMessage(followUp) 续跑。
 *   pi 的 agent.continue() 每次重建 loop config 时重读 agent.state.model，
 *   所以 setModel 之后的续跑用的是新模型（不是请求发起时锁定的旧模型）。
 * - 直连凭据缺失：pi.setModel 返回 false（且 modelRegistry.find 也可能找不到）→ 明确报错，
 *   不静默降级、不假装切过。
 * - setModel 会把新模型写进 settings.json 默认值（异步写队列）；降级后恢复原默认——
 *   立即恢复一次（尽力），并在 agent_settled / session_shutdown 再各补一次
 *   （写队列是异步落盘，首次恢复可能被队列里的旧值覆盖，补刀是必须的）。
 *   只改 defaultProvider/defaultModel 两个字段，不碰用户在降级后改的其它设置。
 *   这样后续按默认启动的 worker 不会静默变成直连（#519 的 Go 主通道不能被这次降级改掉）。
 * - 切换可见性：appendEntry（会话持久记录）+ ui.notify（TUI 提示）+ 一条 custom 消息
 *   （进上下文 + 上屏）+ stderr 日志，否则「切过了」和「本来就没限流」分不开。
 *
 * 配置（默认即生产值，测试环境可用环境变量覆盖）：
 *   PI_GO_FALLBACK_PRIMARY   主通道 provider，默认 "opencode-go"
 *   PI_GO_FALLBACK_PROVIDER  降级目标 provider（直连），默认 "deepseek"
 *   PI_GO_FALLBACK_MODEL     降级目标默认模型（同 id 不存在时兜底），默认 "deepseek-v4-flash"
 *   PI_GO_FALLBACK_TRANSIENT_AFTER  transient 错误连续失败几次后降级，默认 2
 *
 * 纯逻辑（恢复决策）在 go-fallback-core.mjs（node 22 可测），本文件只做运行时接线。
 */

import { planRestore } from "./go-fallback-core.mjs";

const PRIMARY = process.env.PI_GO_FALLBACK_PRIMARY || "opencode-go";
const FALLBACK_PROVIDER = process.env.PI_GO_FALLBACK_PROVIDER || "deepseek";
const FALLBACK_MODEL = process.env.PI_GO_FALLBACK_MODEL || "deepseek-v4-flash";
const TRANSIENT_AFTER = Number(process.env.PI_GO_FALLBACK_TRANSIENT_AFTER || 2);

// 额度耗尽类（pi 判定 non-retryable，重试也没用，首次命中就降级）
const HARD_LIMIT = [
  /GoUsageLimitError/i,
  /FreeUsageLimitError/i,
  /Monthly usage limit/i,
  /available balance/i,
  /insufficient_quota/i,
  /quota exceeded/i,
  /out of budget/i,
  /billing/i,
  /usage limit reached/i,
];

// 瞬时类（pi 会内置重试，连续失败到阈值才降级）
const TRANSIENT = [
  /overloaded/i,
  /rate.?limit/i,
  /too many requests/i,
  /\b429\b/i,
  /\b5\d\d\b/i,
  /service.?unavailable/i,
  /server.?error/i,
  /internal.?error/i,
];

let consecutiveErrors = 0;
let lastSignature = "";

// 降级后待恢复的原默认值；agent_settled / session_shutdown 时补刀恢复。
// fallbackProvider/fallbackModel 是 setModel 试图写入的降级值——恢复决策靠它区分
// 「降级写已落盘」（该写回原值）和「降级写还没落盘」（当前还是原值，必须留 pending 等补刀）。
let pendingRestore = null; // { path, provider, model, fallbackProvider, fallbackModel }

function classify(text) {
  if (HARD_LIMIT.some((re) => re.test(text))) return "hard";
  if (TRANSIENT.some((re) => re.test(text))) return "transient";
  return null;
}

function agentDir() {
  if (process.env.PI_CODING_AGENT_DIR) return process.env.PI_CODING_AGENT_DIR;
  const path = require("path");
  const os = require("os");
  return path.join(os.homedir(), ".pi", "agent");
}

function settingsPath() {
  return require("path").join(agentDir(), "settings.json");
}

/** 读当前文件里的默认 provider/model。读不到返回 null。 */
function readDefaults() {
  try {
    const fs = require("fs");
    const data = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    return {
      provider: data.defaultProvider,
      model: data.defaultModel,
    };
  } catch {
    return null;
  }
}

/**
 * 把 settings.json 的 defaultProvider/defaultModel 恢复成 pendingRestore 里的原值。
 * 只改这两个字段。恢复决策（planRestore）的三个分支：
 * - 当前值 == 降级值 → 写回原值（降级写已落盘，必须还原，否则后续按默认启动的 worker 静默变直连）。
 * - 当前值 == 原值 → 不写、保留 pendingRestore 等补刀（降级写可能还没落盘——旧逻辑在此误清
 *   pending，落盘后补刀变 no-op，settings.json 永远停在降级通道）。
 * - 当前值是其它值 → 用户在降级后手动改了默认，尊重用户，清 pending 不再补刀。
 */
function restoreDefaults() {
  const pending = pendingRestore;
  if (!pending) return;
  try {
    const fs = require("fs");
    const p = settingsPath();
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    const plan = planRestore({
      pending,
      current: { provider: data.defaultProvider, model: data.defaultModel },
    });
    if (plan.action === "wait") return;
    if (plan.action === "respect-user") {
      pendingRestore = null;
      console.error(
        `[go-fallback] settings.json 默认已是 ${plan.from.provider}/${plan.from.model}（非降级值），尊重修改、不再恢复`
      );
      return;
    }
    data.defaultProvider = pending.provider;
    data.defaultModel = pending.model;
    fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf8");
    pendingRestore = null;
    console.error(
      `[go-fallback] 已恢复 settings.json 默认 ${pending.provider}/${pending.model}（降级值 ${plan.from.provider}/${plan.from.model}）`
    );
  } catch (e) {
    console.error(`[go-fallback] 恢复 settings.json 默认值失败: ${e.message}`);
  }
}

export default function (pi) {
  pi.on("agent_end", async (event, ctx) => {
    // 只在主通道（Go）上动作；切过去之后 provider 变了，天然不会循环。
    const model = ctx.model;
    if (!model || model.provider !== PRIMARY) return;

    const msgs = Array.isArray(event.messages) ? event.messages : [];
    let errMsg = null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m && m.role === "assistant") {
        if (m.stopReason === "error" && m.errorMessage) errMsg = m;
        break;
      }
    }
    if (!errMsg) {
      consecutiveErrors = 0; // 本轮正常收尾，重置连续失败计数
      return;
    }

    const text = String(errMsg.errorMessage);
    const kind = classify(text);
    if (!kind) {
      consecutiveErrors = 0;
      return;
    }

    const signature = `${model.provider}/${model.id}::${text.slice(0, 160)}`;
    consecutiveErrors = signature === lastSignature ? consecutiveErrors + 1 : 1;
    lastSignature = signature;

    if (kind === "transient" && consecutiveErrors < TRANSIENT_AFTER) {
      console.error(
        `[go-fallback] 瞬时错误第 ${consecutiveErrors}/${TRANSIENT_AFTER} 次，先让 pi 内置重试: ${text.slice(0, 140)}`
      );
      return;
    }

    // 找降级模型：同 id 优先，找不到用默认兜底模型。
    const fallback =
      ctx.modelRegistry.find(FALLBACK_PROVIDER, model.id) ||
      ctx.modelRegistry.find(FALLBACK_PROVIDER, FALLBACK_MODEL);
    if (!fallback) {
      ctx.ui.notify(
        `go-fallback: 直连 ${FALLBACK_PROVIDER} 无可用模型（${model.id}/${FALLBACK_MODEL}），无法降级`,
        "error"
      );
      console.error(`[go-fallback] 无降级模型: ${FALLBACK_PROVIDER} ${model.id}/${FALLBACK_MODEL}`);
      return;
    }

    // 记下降级前的默认值，降级后恢复（setModel 会异步改写 settings.json 默认）。
    // 同时记下降级写入值：恢复决策要靠它区分「降级写已落盘」与「还没落盘」。
    const original = readDefaults();
    if (original) {
      pendingRestore = {
        path: settingsPath(),
        provider: original.provider,
        model: original.model,
        fallbackProvider: fallback.provider,
        fallbackModel: fallback.id,
      };
    }

    let switched = false;
    try {
      switched = await pi.setModel(fallback);
    } catch (e) {
      console.error(`[go-fallback] setModel 抛错: ${e.message}`);
      switched = false;
    }
    if (!switched) {
      ctx.ui.notify(
        `go-fallback: 直连 ${FALLBACK_PROVIDER} 凭据缺失，无法降级（当前任务将因限流失败）`,
        "error"
      );
      console.error(`[go-fallback] ${FALLBACK_PROVIDER} 凭据缺失，降级失败`);
      pendingRestore = null;
      return;
    }

    const record = {
      at: new Date().toISOString(),
      from: `${model.provider}/${model.id}`,
      to: `${fallback.provider}/${fallback.id}`,
      kind,
      consecutive: consecutiveErrors,
      reason: text.slice(0, 300),
    };

    // 可见记录一：会话持久条目（appendEntry，不占 LLM 上下文）
    try {
      pi.appendEntry("go-fallback", record);
    } catch {}

    // 可见记录二：custom 消息（进上下文 + 上屏），随下一次 turn 注入
    try {
      pi.sendMessage(
        {
          customType: "go-fallback-record",
          content: `〔go-fallback〕opencode Go 通道（${model.provider}/${model.id}）限流/额度耗尽，已自动切到直连 ${fallback.provider}/${fallback.id} 继续。原因：${text.slice(0, 240)}`,
          display: true,
          details: record,
        },
        { deliverAs: "nextTurn" }
      );
    } catch {}

    // 可见记录三：TUI 提示
    try {
      ctx.ui.notify(`go-fallback: 已切直连 ${fallback.id} 继续（${text.slice(0, 60)}）`, "warning");
    } catch {}

    // 续跑：hard（额度耗尽）时 pi 不会重试，必须自己触发续跑——followUp 让当前任务在直连通道上继续
    // （不重启、不从头来）。transient 时 pi 的内置 auto-retry 会在 setModel 后自己继续（重读新模型），
    // 不需要额外触发，也不留多余的收尾轮。
    if (kind === "hard") {
      try {
        pi.sendUserMessage(
          `〔系统：go-fallback〕opencode Go 通道限流/额度耗尽，本会话已自动切换到直连 ${fallback.provider}/${fallback.id} 继续。请接着当前任务往下做：不要重新开始、不要重复已完成步骤，把没做完的部分做完。`,
          { deliverAs: "followUp" }
        );
      } catch (e) {
        console.error(`[go-fallback] 续跑消息发送失败: ${e.message}`);
      }
    }

    // 补刀恢复默认（setModel 的 settings 写队列是异步落盘，首恢复可能被旧值覆盖）
    setTimeout(restoreDefaults, 500);
  });

  // 一轮 agent run 彻底结束后再补一刀（写队列此时早已排空）
  pi.on("agent_settled", () => {
    restoreDefaults();
  });

  // 会话退出前的最后一道保险
  pi.on("session_shutdown", () => {
    restoreDefaults();
  });
}
