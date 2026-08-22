// 该不该问「是否退出值守/专注」—— 纯函数（issue #607 ①）。
//
// 输入是数字，输出是结论；没有文件、没有 env、没有副作用，测试直接 import。
// 语义判断（「这件事我能自己拍吗」）**不许纯函数化**——那是自拍登记的事（issue #607 第二件），
// 本模块只做可机械判定的部分。
//
// 阈值默认值依据（不许凭猜）：
//   hours    8 —— 一觉通常 ≤ 8 小时；值守/专注挂满 8 小时仍无动静，说明多半不是「睡觉」
//                 而是忘了退/离开了。2026-08-17 事故就是值守挂了 17.2 小时无人质疑。
//   messages 3 —— 容忍进入值守后的 1~2 条「尾巴」（晚安、补充授权），第 3 条起视为用户
//                 回来工作。UserPromptSubmit 每次触发就是一条在场证据，本函数消费它。
//   offTopic 2 —— 复用「同一种办法连错两次就换路」：连续两次偏离 = 用户在派新活，必然在场。
//
// 阈值可配：调用方从环境变量 DAO_EXIT_HOURS / DAO_EXIT_MESSAGES / DAO_EXIT_OFFTOPIC 读，
// 本模块保持纯函数（不读 env）。

export const EXIT_DEFAULTS = { hours: 8, messages: 3, offTopic: 2 };

/**
 * @param {{mode: string, hours?: number, messages?: number, offTopicStreak?: number, thresholds?: object}} s
 * @returns {{ask: boolean, reasons: string[]}} ask=true 时 reasons 是人话理由，供注入直接拼结论行。
 */
export function shouldAskExit({ mode, hours = 0, messages = 0, offTopicStreak = 0, thresholds } = {}) {
  const t = { ...EXIT_DEFAULTS, ...(thresholds || {}) };
  if (mode === 'normal') return { ask: false, reasons: [] };

  if (mode === 'standby') {
    const reasons = [];
    if (hours >= t.hours) reasons.push(`已值守 ${fmtHours(hours)}`);
    if (messages >= t.messages) reasons.push(`此间用户发了 ${messages} 条消息`);
    if (offTopicStreak >= t.offTopic) reasons.push(`连续偏离 ${offTopicStreak} 次`);
    return { ask: reasons.length > 0, reasons };
  }

  if (mode === 'focus') {
    // 专注下用户在场是常态，消息多 = 用户正在专注，不打扰。
    // 只有「挂得久 + 此间一条消息都没有」才提示：用户可能已离开，焦点锁着没人管。
    if (hours >= t.hours && messages === 0) {
      return { ask: true, reasons: [`已专注 ${fmtHours(hours)}，此间无消息`] };
    }
    return { ask: false, reasons: [] };
  }

  // unreadable 不归这里：调用方按「态没查成」处理，不许静默当常态。
  return { ask: false, reasons: [] };
}

function fmtHours(h) {
  return `${Math.floor(h * 10) / 10} 小时`;
}
