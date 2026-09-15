// scripts/lib/leg-liveness.mjs —— 「这条腿现在还跑不跑得动」的行为判据（纯函数，零 IO）
//
// 2026-09-15 实咬，整块盘面停了一天：
//
//   34 张开放 PR，reviewDecision 全部为空；合并吞吐 72 小时 29 张（≈10/天）→ 近 24 小时 2 张。
//   近 23 个审官会话里 18 个 runState=incomplete，死因原文一模一样：
//     "stream disconnected before completion: stream closed before response.completed"
//   mirasim turn 结局：13:24 起开始 error，14:33 之后连 14 次全 error，没有一次 ok。
//   而 33 张有标的 PR 里 31 张写着 reviewer/gpt-5.6-luna——**整条 gpt 腿死了**。
//
// 想换到还活着的 grok 腿，被审官位闸挡住，理由是：
//
//   「换厂只在上一位死于满载/看门狗时成立：上一位的死因不是满载/看门狗那一类」
//
// 那道闸的判据是一张**词表**（`CAPACITY_DEATH_RE`，2026-09-07 从两条真会话上抄的
// "at capacity" / "turn stalled"）。今天这种死法不在表里，于是：
// **腿死了，闸看得见死因，却因为死因用词没见过而不许换到活着的腿。**
// 判例 memory `whitelist-fingerprints-cannot-find-unseen-failures`：
// 靠匹配已知错误字样发现故障，只找得到见过的失败。
//
// 所以这里不给词表再加一个词——那是给同一个办法打第二层补丁，而且下一种新死法照样卡住。
// 改判据：**一条腿活不活，看它最近 N 次会话的结局，不看死因用了哪个词。**
//
// 为什么这比词表更难被滥用（原注释担心的「换厂变成挑模型的后门」）：
//   · 词表能被措辞骗——写出「at capacity」四个字就能换厂；
//   · 结局骗不了——要让一条腿看起来死了，得真的让它连着几次跑不完。
//   · 而且只看**结局**，不看判定内容：判红是 completed，不算死。「审得不好」永远换不了厂。

/** 算「这条腿死了」至少要看几次。太少会把一次网络抖动当成腿断。 */
export const MIN_SAMPLES = 5;
/**
 * 死亡率到多少算腿断。0.75 = 四次里跑不完三次——到这个份上它已经不是「偶尔抖」了。
 *
 * 刻度不按今天的数字调（今天 luna 是 18/22 = 0.818，离 0.8 只差 0.018——
 * 拿那条线当阈值就是照着一个样本刻线，明天换个形状就失灵）。取 0.75 是因为
 * 「四次里坏三次」是一句人能判断对错的话，不是一个拟合出来的数。
 */
export const DEAD_RATIO = 0.75;
/** 多旧的会话就不算数了（毫秒）。默认 6 小时：再早的死跟「现在跑不跑得动」无关。 */
export const SAMPLE_WINDOW_MS = 6 * 60 * 60 * 1000;

// 状态词一律走正典 `lib/execution-states.mjs`，**不许在这里另写一张表**。
//
// #1290 首审当场逮到：第一版手抄了两个 Set，于是正典里的成功态 `complete`/`finished`
// 被算成死、管理态 `pending`/`stopping`（启动或收尾只走了一半，答案还不知道）也被算成死。
// 五条 `pending` 样本就能把一条健康的腿判成跑不动，进而触发错误换厂。
// 判例 memory `hand-typed-constant-will-be-wrong`：凡是要手打的常量早晚被凭印象填。
//
// 三分法（与正典同源）：
//   · RESERVED（pending/uncertain/stopping）＋ 活着的（running/streaming/…）→ **不当样本**
//   · SUCCEEDED（done/completed/complete/finished）                        → 样本，不算死
//   · 其余 FINISHED（failed/error/aborted/incomplete/gone/…）              → 样本，算死
//   · 正典之外的词（含字面 `unknown`）                                     → **不当样本**
//     ——认不出的状态不许当死：判不出来就别投票，这是本仓「没查成 ≠ 查过没事」的同一条。
import { EXECUTION_SUCCEEDED, EXECUTION_FINISHED, EXECUTION_RESERVED } from './execution-states.mjs';

function stateOf(r) {
  return String((r && (r.state ?? r.runState ?? r.observedState)) || '').trim().toLowerCase();
}

function atOf(r) {
  const v = r && (r.at ?? r.updatedAt ?? r.observedAt ?? r.createdAt);
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const p = Date.parse(String(v || ''));
  return Number.isFinite(p) ? p : null;
}

/**
 * 判一条腿现在是不是跑不动了。
 *
 * `records` 是这条腿**最近的会话记录**（调用方负责按 profile/模型筛好——本模块不碰 IO）。
 * 每条只要能读出结局和时间：`observedState`/`runState`/`state` + `updatedAt`/`createdAt`。
 *
 * 返回 `{ down, scanned, samples, dead, ratio, why }`。
 * **`scanned:false` 时 `down` 恒为 false**：读不到就不许判腿断——
 * 「没查成」当成「腿断了」会让换厂变成一个只要把日志弄坏就能打开的后门。
 */
export function judgeLegDown(records, {
  now = Date.now(),
  minSamples = MIN_SAMPLES,
  deadRatio = DEAD_RATIO,
  windowMs = SAMPLE_WINDOW_MS,
} = {}) {
  if (!Array.isArray(records)) {
    return { down: false, scanned: false, samples: 0, dead: 0, ratio: null, why: '会话记录不是数组（没查成，不许判腿断）' };
  }
  const fresh = [];
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    const st = stateOf(r);
    if (!st) continue;                 // 结局读不出来的不当样本，也不当死
    if (EXECUTION_RESERVED.has(st)) continue;   // 启动/收尾走了一半，答案还不知道
    if (!EXECUTION_FINISHED.has(st)) continue;  // 还在跑的、以及正典认不出的词，都不投票
    const at = atOf(r);
    if (at == null) continue;          // 时间读不出来 ⇒ 判不了新旧，不当样本
    if (now - at > windowMs) continue;
    fresh.push({ st, at });
  }
  if (fresh.length < minSamples) {
    return {
      down: false, scanned: true, samples: fresh.length, dead: 0, ratio: null,
      why: `窗口内只有 ${fresh.length} 次跑完的会话，不足 ${minSamples} 次——样本不够，不判腿断`,
    };
  }
  fresh.sort((a, b) => b.at - a.at);
  const dead = fresh.filter((r) => !EXECUTION_SUCCEEDED.has(r.st)).length;
  const ratio = dead / fresh.length;
  // **不额外要求「最近一次也是死的」**（2026-09-15 实测否掉的第一版）：
  // 那条加上去之后，luna 明明 22 次死 18 次（82%），只因为最后一次侥幸跑完，
  // 判据就说「腿还活着」——一次成功掩盖一条跑不动的腿，正是本单要治的反面。
  // 恢复靠窗口自己走：新的成功进窗口，比率自然掉下阈值，闸就重新合上。
  const down = ratio >= deadRatio;
  return {
    down,
    scanned: true,
    samples: fresh.length,
    dead,
    ratio,
    why: `最近 ${fresh.length} 次会话死了 ${dead} 次（${Math.round(ratio * 100)}%）`
      + (down
        ? `，到了 ${Math.round(deadRatio * 100)}% 这条线——这条腿现在跑不动`
        : `，没到 ${Math.round(deadRatio * 100)}%——还不算腿断`),
  };
}
