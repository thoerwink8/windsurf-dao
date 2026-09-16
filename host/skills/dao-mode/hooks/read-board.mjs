// 盘面卡没卡 —— 值守提问闸的主判据输入（#1287，2026-09-15 用户拍板）。
//
// 为什么单独一个文件，而不是塞进 dao-mode.mjs：
// **`dao-mode.mjs` 一被 import 就会跑 hook 并结束进程。** 把 readBoard 放在那里，
// 任何 `await import(...)` 它的测试文件都会在那一行当场退出——而 node --test 看到子进程
// exit 0，报的是**绿**。我第一版就是这么写的，故意把断言改错也照样绿，
// 靠「上线前先造违规样本」才抓出来。所以判据的输入端必须是**无副作用可导入**的模块。
//
// 也不能塞进 should-ask-exit.mjs：那个文件的契约写明「没有文件、没有 env、没有副作用」，
// 本模块要读文件，进去就破了它的纯函数性。
//
// 落点由指挥官每轮覆盖写（scripts/commander.mjs 的 writeBoardStuck）。
// dao-mode 是跨项目的全局 hook，不该知道 windsurf-dao 的内部状态长什么样，
// 所以约定这份字段极少、项目无关的文件，而不是去翻 ~/.dao/commander/situation-*.json。

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const BOARD_FILE = process.env.DAO_BOARD_FILE
  || join(homedir(), '.dao', 'board-stuck.json');

// 超过这个岁数就当没查成。指挥官死了，这份文件会**停在最后一次的好消息上**，
// 拿它当真就会把「编排已经不跑了」读成「盘面很健康」——那正是本单要治的病的镜像
// （判例 memory `clean-exit-is-still-down`：沉默要能与死机区分）。
export const BOARD_STALE_MS = 90 * 60 * 1000;

/**
 * 读盘面事实。读不到 / 读坏 / 过期，一律回 `{scanned:false, why}`，
 * 由 shouldAskExit 退回时长-消息数兜底——**「没查成」不许当成「没卡住」**。
 *
 * @param {string} [path] 覆盖落点（测试用）
 * @param {number} [now]  覆盖当前时刻（测试用，假时钟）
 */
export function readBoard(path = BOARD_FILE, now = Date.now()) {
  if (!existsSync(path)) return { scanned: false, why: `${path} 不在` };
  let doc;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return { scanned: false, why: `读不了/不是 JSON：${String(e.message || e).slice(0, 60)}` };
  }
  if (!doc || typeof doc !== 'object') return { scanned: false, why: '内容不是对象' };
  const at = Date.parse(doc.at || '');
  if (!Number.isFinite(at)) return { scanned: false, why: '没有可用的 at 时间戳' };
  const age = now - at;
  if (age > BOARD_STALE_MS) {
    return { scanned: false, why: `已过期 ${Math.round(age / 60000)} 分钟——指挥官可能没在跑` };
  }
  // waitingUser 写侧在 GitHub 没扫到时记 null。null / 缺字段 = 没查成，不是 0。
  // 整份盘面因此不能当已查成——判定侧若 Number(null)||0，提问闸会静默关掉。
  if (doc.waitingUser == null) {
    return { scanned: false, why: 'waitingUser 没查成（GitHub 未扫描）' };
  }
  // 契约：两个量都是非负整数。字符串 / 布尔 / NaN / 负数经 Number(...)||0
  // 都会变成「健康 0」，提问闸按 basis:board 放行，坏数据就静默屏蔽兜底。
  const waiting = asNonNegInt(doc.waitingUser, 'waitingUser');
  if (waiting.why) return { scanned: false, why: waiting.why };
  const stalled = asNonNegInt(doc.stalledRounds, 'stalledRounds');
  if (stalled.why) return { scanned: false, why: stalled.why };
  return {
    scanned: true,
    stalledRounds: stalled.value,
    waitingUser: waiting.value,
    at: doc.at,
  };
}

/** 缺字段、非法类型、NaN、负数一律不是非负整数。 */
function asNonNegInt(v, name) {
  if (!Number.isInteger(v) || v < 0) {
    return { why: `${name} 不是非负整数（读到 ${JSON.stringify(v)}）` };
  }
  return { value: v };
}
