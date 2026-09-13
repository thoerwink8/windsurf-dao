// scripts/lib/retry-epoch.mjs —— 重试账的「判据版本」（#1236）
//
// 病（2026-09-13 实咬）：重试次数按 `<动词>:<pr>@<head>` 记在 state.json 里，
// **键只跟 head 走，不跟代码版本走**。于是修法落到 master 之后，旧账里那 3 次失败
// 还挂在同一个 head 上——修好了，可没人给它第四次机会。
//
// 实测形状：PR #1118 在 ~/.dao/exhausted-push.json 里被认输 **32 次**（#1127 18 次、
// #1129 15 次），一周里「认输 → 推送 → 摘标 → 再认输」转磨盘。人的处置是「摘标重推」，
// 重推仍读到那份旧账，当场又试满；#1111 上留过更正：「标是症状，病是 rereview 推不动」——
// 对，但还有更深一层：**推不动的判据已经修了，账没作废**。
//
// 与 #1208「快照里的 head 被当幂等键，快照一过期整条链冻住」是同一个形状：
// 拿一个已经失效的旧账当判据，链就卡在旧格上。
//
// 所以给重试键加一段判据版本：**决定「能不能推得动」的代码变了，旧账自动作废**。
// 新键不匹配旧记录 ⇒ tries 从 0 起算 ⇒ 修好的局面重新获得 N 次机会。
//
// 为什么是代码指纹而不是手打常量：凡是需要手打的常量早晚会被凭印象填
// （判例 memory `hand-typed-constant-will-be-wrong`）。指纹从文件内容算，改法落地即自动生效，
// 不依赖「记得改那个数」。
//
// 代价与取舍：指纹变了会**一次性**重置所有在途 PR 的重试计数。这发生在每次改动
// FILE_SET 里任一文件时，净效果是「让修好的局面重获机会」——这正是我们要的；
// 而「本来该认输的 PR 多试 3 次」的代价远小于「修好的 PR 永远卡死」。
// 计数不是安全闸，放宽它不危险（认输只影响自动化是否继续重试，不影响任何授权）。

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

/**
 * 判据真源：决定「这张 PR 现在还推不推得动」的代码。
 *
 * 选文件的判据是**它参与判断重试能不能成功**，不是「它最近改过」：
 *   · execution-runtime.mjs —— 执行目录解析（`resolveExecutionProfile` 的拒/放）
 *   · dispatch/reviewer.mjs —— 审官叫起与顺位
 *   · dispatch/lease.mjs    —— 树租约（起不来的另一大类）
 *   · commander-verbs.mjs   —— retry-drain 的账键与闸
 *   · model-routing-json.mjs —— 顺位 × 执行目录可用性（#1233）
 *
 * 不追求完备。**漏一个文件 = 那类修法落地后旧账仍作废不了**（退回今天的行为，
 * 不比现在差）；**多一个文件 = 无关改动也会重置计数**（多试 3 次，代价可忽略）。
 * 所以宁可窄不可宽——窄的失效方式是「没帮上忙」，宽的是「帮了倒忙」。
 */
export const EPOCH_FILES = [
  'scripts/lib/execution-runtime.mjs',
  'scripts/lib/dispatch/reviewer.mjs',
  'scripts/lib/dispatch/lease.mjs',
  'scripts/lib/commander-verbs.mjs',
  'scripts/lib/model-routing-json.mjs',
];

/**
 * 算判据版本：FILE_SET 内容的 sha256 前 12 位。
 *
 * 读不到任何一个文件 → 返回 `null`，调用方**退回不带版本的键**（也就是今天的行为），
 * 并把这个事实报出来。空串/"unknown" 会让所有键长得一样，把「没算成」伪装成「版本一致」
 * ——那比退回旧行为更糟：旧行为至少是对的，伪装会让不同代码版本共用一本账。
 *
 * 纯函数、无缓存：文件在进程生命周期里不会变（node 起来后不会重写自己的源码），
 * 而加缓存又会引入「缓存什么时候失效」这个新问题。
 *
 * @param {{readFile?: Function, root?: string}} [opts] 测试可注入
 * @returns {{ok: true, epoch: string, files: number} | {ok: false, epoch: null, why: string}}
 */
export function retryEpoch({ readFile = fs.readFileSync, root = ROOT } = {}) {
  const h = createHash('sha256');
  let read = 0;
  for (const rel of EPOCH_FILES) {
    let buf;
    try {
      buf = readFile(path.join(root, rel));
    } catch (e) {
      return { ok: false, epoch: null, why: `判据文件读不到：${rel}（${e.code || e.message}）` };
    }
    // 带文件名一起喂进去：换文件顺序、增删文件都要让指纹变，
    // 否则「把 A 的内容挪到 B」这种改动指纹不变。
    h.update(rel);
    h.update('\0');
    h.update(buf);
    h.update('\0');
    read += 1;
  }
  return { ok: true, epoch: h.digest('hex').slice(0, 12), files: read };
}

/**
 * 把判据版本并进重试键：`<base>@e<epoch>`；算不出指纹时原样返回 base（退回旧行为）。
 *
 * 分隔符用 `@e` 而不是裸 `@`：head 是 40 位 hex、epoch 是 12 位 hex，
 * 万一有人拿老键去 parse，`@e` 前缀能一眼看出后半段不是 head。
 */
export function stampRetryKey(base, epoch) {
  const b = String(base || '');
  if (!b) return b;
  const e = typeof epoch === 'string' && /^[0-9a-f]{12}$/.test(epoch) ? epoch : null;
  return e ? `${b}@e${e}` : b;
}
