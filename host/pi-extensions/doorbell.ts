// doorbell.ts —— 空闲短门铃叫醒协调者（issue #645）
//
// 机制（#644/#645 消歧记录，2026-08-18 用户拍）：
//   - 协调者（帅）的 pi 会话空闲（输入框空、没在打字）时，工人发完工/上报
//     应该叫醒协调者开一轮处理。实现 = 被动盯 `_flow/inbox-*.log`
//     的新消息，命中时 `pi.sendUserMessage("你有来信")` 代按一句短门铃再回车。
//   - 人在打字（输入框非空）→ 绝不占输入框（不响门铃、不碰编辑框）。
//   - 信的正文 → 不进输入框，只在对话里（门铃只进短句；正文留在 relay 日志里，
//     协调者按 dispatch skill 自己 tail 日志 / 查信箱）。
//   - 通道 → 仍只一个等信者（现有信箱台），本扩展只读日志、不挂第二个
//     `check --wait`，不拆信箱台（dispatch skill #525：一个 run 只一个 waiter）。
//
// 为什么盯日志而不是 `orca orchestration check`：
//   历史上 relay（inbox-station.mjs，#807 已删）是 run 的唯一等信者，check --wait 会跟它
//   抢 waiter（#525 刷屏）；本扩展只读 relay 落盘的 `_flow/inbox-<run后缀>.log`
//   （格式见 formatLogLine），零冲突。
//
// 配置（环境变量，默认即生产值）：
//   PI_DOORBELL_LOG_DIR  信箱台日志目录（默认 <cwd>/_flow）
//   PI_DOORBELL_POLL_MS  轮询间隔毫秒（默认 2000）
//   PI_DOORBELL_COOLDOWN_MS 两次门铃最短间隔（默认 10000；一批消息只响一次）
//   PI_DOORBELL_TEXT     门铃短句（默认「你有来信」）
//
// 纯逻辑全在 doorbell-core.mjs（node 22 可测），本文件只做运行时接线。

import {
  DOORBELL_TEXT,
  logDirFor,
  pollOnce,
} from './doorbell-core.mjs';

const DEFAULT_POLL_MS = 2000;
const DEFAULT_COOLDOWN_MS = 10000;

function envNum(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export default function (pi) {
  let timer = null;
  let offsets = new Map();
  let seenIds = new Set();
  let pendingIds = new Set();
  let primeFiles = new Set();
  let lastRingAt = 0;

  pi.on('session_start', (_event, ctx) => {
    // 只在 TUI 会话动作；print/json 模式没有输入框，直接不启动。
    if (ctx.mode !== 'tui') return;
    if (!process.env.ORCA_PANE_KEY) return;
    const dir = logDirFor(ctx.cwd);
    // /reload 会再触发 session_start：先清旧定时器，避免叠两个轮询。
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    const pollMs = envNum('PI_DOORBELL_POLL_MS', DEFAULT_POLL_MS);
    const cooldownMs = envNum('PI_DOORBELL_COOLDOWN_MS', DEFAULT_COOLDOWN_MS);
    const text = process.env.PI_DOORBELL_TEXT || DOORBELL_TEXT;

    // 红 2 修法：不再用「启动瞬间有没有 inbox-*.log」当永久开关——
    // TUI + ORCA_PANE_KEY 就挂轮询；日志从无到有时（新机 / 归档清 `_flow` /
    // 新 Run 首信才建日志）由 pollOnce 按文件首次见到做 prime，不会永久失聪。
    // 工人树里没有 inbox 日志，只是每轮对空目录 readdir，不会误响。
    const tick = () => {
      const r = pollOnce({
        dir,
        offsets,
        seenIds,
        pendingIds,
        primeFiles,
        lastRingAt,
        now: Date.now(),
        cooldownMs,
        ctx,
        sendUserMessage: (t) => pi.sendUserMessage(t),
        text,
      });
      if (r.rang) lastRingAt = Date.now();
    };

    tick();
    timer = setInterval(tick, pollMs);
    if (typeof timer.unref === 'function') timer.unref();
  });

  pi.on('session_shutdown', () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    offsets = new Map();
    seenIds = new Set();
    pendingIds = new Set();
    primeFiles = new Set();
    lastRingAt = 0;
  });
}
