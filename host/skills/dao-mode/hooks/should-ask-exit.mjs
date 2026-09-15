// 该不该问「是否退出值守/专注」—— 纯函数（issue #607 ①）。
//
// 输入是数字，输出是结论；没有文件、没有 env、没有副作用，测试直接 import。
// 语义判断（「这件事我能自己拍吗」）**不许纯函数化**——那是自拍登记的事（issue #607 第二件），
// 本模块只做可机械判定的部分。
//
// 阈值默认值依据（不许凭猜）：
//   offTopic 2 —— 复用「同一种办法连错两次就换路」：连续两次偏离 = 用户在派新活，必然在场。
//   stalled  6 —— 一轮 ≈ 20 分钟；盘面连续 6 轮零推进 ≈ 2 小时，已经不是「正在跑」。
//   hours    8 / messages 3 —— **只在盘面事实读不到时才用的兜底**，来历见下。
//
// 2026-09-15 用户拍板改判据。原来值守的提问条件是「挂了多久 / 用户说了几句」，
// 依据写的是「一觉通常 ≤ 8 小时，挂满 8 小时多半是忘了退」。那是为「过一夜」设计的，
// 而这位用户的真实用法是**长期挂着、随时插话**：131 小时里发了 300 多条消息，
// 于是三条阈值在第一天就全部永久触发，警告连响 130 小时。
// **永远在响的警告等于没有警告**——它训练人（和 AI）把它当背景音。
//
// 该打扰用户的时机不是「挂了多久」，是**有事卡住了、只有他能解**：
// 盘面连续 N 轮零推进、或有对象挂着「等用户」。没有这些就别打扰，有了就立刻打扰。
//
// 兜底不许删：盘面事实**读不到**时退回时长/消息数那套旧判据。
// 「没查成」不许当成「没卡住」——那会让提问闸静默失效，比多问几次糟得多。
//
// 阈值可配：调用方从环境变量 DAO_EXIT_HOURS / DAO_EXIT_MESSAGES / DAO_EXIT_OFFTOPIC /
// DAO_EXIT_STALLED 读，本模块保持纯函数（不读 env）。

export const EXIT_DEFAULTS = { hours: 8, messages: 3, offTopic: 2, stalled: 6 };

/**
 * @param {object} s
 * @param {string} s.mode 'normal' | 'standby' | 'focus'
 * @param {object} [s.board] 盘面事实 `{scanned, stalledRounds, waitingUser, why}`。
 *   `scanned !== true` 一律当没查成，退回时长/消息数兜底。
 * @returns {{ask: boolean, reasons: string[], basis?: string}} ask=true 时 reasons 是人话理由。
 *   `basis` 说明这次是按盘面判的还是兜底判的——排障时要分得开。
 */
export function shouldAskExit({
  mode, hours = 0, messages = 0, offTopicStreak = 0, board = null, thresholds,
} = {}) {
  const t = { ...EXIT_DEFAULTS, ...(thresholds || {}) };
  if (mode === 'normal') return { ask: false, reasons: [] };

  if (mode === 'standby') {
    const reasons = [];
    // 偏离与盘面无关：连续两次偏离 = 用户在派新活，本来就在场。两套判据下都保留。
    if (offTopicStreak >= t.offTopic) reasons.push(`连续偏离 ${offTopicStreak} 次`);

    if (board && board.scanned === true) {
      // 主判据：只有「卡住了、只有用户能解」才打扰。
      const stalled = Number(board.stalledRounds) || 0;
      const waiting = Number(board.waitingUser) || 0;
      if (stalled >= t.stalled) {
        reasons.push(`盘面连续 ${stalled} 轮零推进（约 ${Math.round(stalled * 20 / 60 * 10) / 10} 小时）`);
      }
      if (waiting > 0) reasons.push(`${waiting} 个对象挂着「等用户」，只有你能解`);
      return { ask: reasons.length > 0, reasons, basis: 'board' };
    }

    // 兜底：盘面没查成 ⇒ 退回旧判据。不许把「没查成」当成「没卡住」。
    if (hours >= t.hours) reasons.push(`已值守 ${fmtHours(hours)}`);
    if (messages >= t.messages) reasons.push(`此间用户发了 ${messages} 条消息`);
    const why = board && board.why ? `（盘面没查成：${board.why}）` : '（盘面事实没读到）';
    if (reasons.length > 0) reasons.push(`按时长/消息数兜底判的${why}`);
    return { ask: reasons.length > 0, reasons, basis: 'fallback' };
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
