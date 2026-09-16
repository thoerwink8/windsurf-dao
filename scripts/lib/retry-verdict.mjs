// scripts/lib/retry-verdict.mjs —— 「这次失败再试一次会不会不一样」（#1237）
//
// 病（2026-09-13 实咬，7 天日志 274 条错误里 54% 是这一类）：
//
//   93 次  session-stop 找不到那棵树（树已经没了，重试 1 万次也一样）
//   41 次  账本里没有 job.dispatch 记录（这是**数据缺失**，不是**状态不对**）
//
// 现行机制对它们一视同仁地**试满 3 次**。DRAIN_GRACE_MIN=45 分钟 × 3 = **最快的病也要
// 两小时后才见到人**，而这两小时里它一次都没可能成功。更坏的是：试满之后打的是
// 「自动化认输」，读的人以为「机械重试无解」——其实一次都不该试。
//
// 所以这里做一件很窄的事：把失败分成三类，让**该快的快、该慢的慢**。
//
// 判据不是症状词表，是一个问题：**这个失败的成因，在重试能改变的范围里吗？**
//   · 缺数据 / 缺文件 / 配置被判死  → 重试不会让数据长出来、不会让判据改主意 → **不可试**
//   · 资源被占 / 状态在变          → 时间会解决，下一轮可能是新局面           → **可试**
//   · 认不出来                    → 不许猜（猜错会把不可试的拖成两小时）      → **未分类**
//
// 「未分类」按**可试**处理（保守：宁可多试一次，也别把能自愈的当场推给人），
// 但把「未分类」本身报出来——它是词表该长的信号，不是静默的兜底。

/** 不可试：成因在重试范围之外。命中即当场交人，不烧重试名额。 */
const TERMINAL = [
  /账本没有/,                                 // 账本里没这条记录（数据缺失）
  /需人工打标|缺 (?:repo|model)|缺 repo/i,     // 标签/字段缺失（#1116 那类）
  /no such file|ENOENT|lstat/i,               // 文件/树已经不在了
  /找不到卡|不存在/,
  /unverified|disabled|invalid execution profile|unknown execution profile/i, // 执行目录判死
  /not a git repository|bad revision/i,
  /review-rounds-exceeded/,                   // #1227 预算闸：再试不会让轮次变少
];

/** 可试：成因会随时间改变。命中即照常走「宽限期 + 试满」。 */
const RETRYABLE = [
  /已经有 \d+ 个会话进程|already has an active|unresolved launch|already exists/i, // 资源被占
  /CONFLICTING|MERGEABLE=UNKNOWN|mergeable=UNKNOWN/i,                              // 状态在变
  /连不上|timeout|超时|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/i,                          // 上游抖动
  /宽限|grace|held|满载/,                                                          // 背压（本来就不记 tries）
];

/**
 * @param {string|Error|null} error 失败原文
 * @returns {{verdict: 'terminal'|'retryable'|'unknown', why: string, matched: string|null}}
 *   terminal  → 当场交人（不烧名额）
 *   retryable → 照常宽限期 + 试满
 *   unknown   → 按 retryable 处理，但要报出来（词表该长）
 */
export function judgeRetry({ error } = {}) {
  const text = String((error && error.message) || error || '').trim();
  if (!text) return { verdict: 'unknown', why: '没有失败原文，判不了能不能再试', matched: null };
  for (const re of TERMINAL) {
    if (re.test(text)) {
      return {
        verdict: 'terminal',
        why: '这个失败重试不会变——成因在重试能改变的范围之外',
        matched: String(re),
      };
    }
  }
  for (const re of RETRYABLE) {
    if (re.test(text)) {
      return {
        verdict: 'retryable',
        why: '这个失败会随时间改变——值得再试',
        matched: String(re),
      };
    }
  }
  return {
    verdict: 'unknown',
    why: '认不出是哪一类——按「可试」走（宁可多试一次，也别把能自愈的推给人），但这条该进词表',
    matched: null,
  };
}

/**
 * 一句话说清「试满了几次、为什么不再试了」——给认输评论用。
 *
 * 两种结局要分得开（混成一句就会误导读的人往错方向查）：
 *   · terminal：**一次都不该试**，现在就交人
 *   · retryable：真试满了，机械重试确实无解
 */
/** 同一句失败原文连着几轮出现就判「重试不会变」。2 = 看见它重复了一次。 */
export const SAME_ERROR_ROUNDS_TO_STUCK = 2;

/**
 * 不看词、只看行为的「这个失败重试不会变」判据。
 *
 * `judgeRetry` 靠词表认失败类型，认不出的一律按「可试」放行——这是它的正确设计
 * （宁可多试一次，也别把能自愈的推给人），但它只找得到**见过**的失败
 * （memory `whitelist-fingerprints-cannot-find-unseen-failures`）。
 *
 * 2026-09-14 实咬：三句真实的闸拒原文喂进 judgeRetry，两句判 `retryable`、一句判 `unknown`，
 * 没有一句判 terminal——而它们全都是**确定性拒绝**，输入不变就永远是这个结果：
 *   · 「先让工人 rebase master，别派审官白审（mergeable=CONFLICTING）」
 *   · 「审官位只许同厂换顺位（当前 gpt-5.6-luna／gpt），不许换厂到 grok-4.6／grok」
 *   · 「审官位只许审官顺位表里的模型（…），kimi-k3 不在表里」
 * 于是每 20 分钟白试一次，试满 3 次打「卡死/自动化认输」，写的理由还是无关的
 * 「叫了 3 次审官判定仍是 0」。
 *
 * 把这三句加进词表是**错的修法**：下一句没见过的照样漏（memory
 * `predicate-must-tell-absence-from-negation`：先量行为再定判据，不用词表黑名单）。
 * 这里改判**行为**——同一格上连着拿回一模一样的原文，就是「再试还是这个结果」的直接证据，
 * 与那句话是谁写的、说的什么完全无关，没见过的新失败一样拦得住。
 *
 * 判「一模一样」用整串原文相等，**不做归一化**（含不 trim）：错误里常带 head / 模型名 / 计数，
 * 归一化会把「换了个模型仍然拒」和「同一个拒绝」揉成一件事，那正是要分开的两件。
 * 反过来，原文只要变了一个字就重新计数——宁可多试一轮，也别把「情况变了」当成没变。
 * 空串 / 非字符串 = 没原文，不算「一直是它」；首尾空白也是原文的一部分。
 *
 * 调用方必须把**完整原文**传进来。截首行、截 N 字都是归一化，会把「前缀相同、后文不同」
 * 的两句失败揉成同一错。人读摘要走 exhaustedReasonText / exhaustedComment，不在比较键上截。
 */
export function judgeRepeatedFailure(prev) {
  if (!prev || typeof prev !== 'object') return { stuck: false, why: '没有上一轮的账' };
  const err = typeof prev.lastError === 'string' ? prev.lastError : '';
  if (!err) return { stuck: false, why: '上一轮没记下失败原文——没查成不算「一直是它」' };
  const rounds = Number(prev.sameErrorRounds);
  if (!Number.isInteger(rounds) || rounds < SAME_ERROR_ROUNDS_TO_STUCK) {
    return { stuck: false, rounds: Number.isInteger(rounds) ? rounds : 0, why: '还没重复够轮数' };
  }
  return { stuck: true, rounds, error: err, why: `连着 ${rounds} 轮拿回一模一样的失败原文` };
}

/**
 * 把这一轮的失败原文并进账（exec 侧调用，纯函数好测）。
 * 原文与上一轮**逐字相同**（整串相等，不 trim）⇒ 轮数 +1；变了 / 这轮成功了 ⇒ 从头数。
 * 空串 / 非字符串 ⇒ 清零。首尾空白也是原文，不算空。
 * 比较的就是传入的那一串：调用方截过再传入，这里看不见被截掉的差别。
 */
export function foldFailureStreak(prev, error) {
  const err = typeof error === 'string' ? error : '';
  if (!err) return { lastError: null, sameErrorRounds: 0 };
  const was = prev && typeof prev.lastError === 'string' ? prev.lastError : '';
  const rounds = was === err ? (Number(prev?.sameErrorRounds) || 1) + 1 : 1;
  return { lastError: err, sameErrorRounds: rounds };
}

export function exhaustedReasonText({ verdict, tries, error, maxTries } = {}) {
  const n = Number(tries) || 0;
  const cap = Number(maxTries) || 0;
  const first = String(error || '').trim().split(/\r?\n/)[0].slice(0, 300) || '（没留下失败原文）';
  if (verdict === 'terminal') {
    return `最后一次失败的原因：${first}\n\n`
      + `**这一类失败重试不会变**（成因在重试能改变的范围之外），所以不再试第 ${n + 1} 次`
      + `——直接交人，不烧满 ${cap || n} 次名额。`;
  }
  return `最后一次失败的原因：${first}\n\n`
    + `试了 ${n} 次仍没推动（上限 ${cap || '?'} 次），下一轮不会自动重试。`;
}

// ── 故意违规正控（本模块的判据必须两头都有判别力）──────────────────────────
// 上线前先拿这两组样本喂一遍：不可试的必须判 terminal，可试的必须判 retryable。
// 判错的后果不对称——把 terminal 判成 retryable = 白等两小时；反过来 = 把能自愈的推给人。
export const RETRY_VERDICT_PROBES = {
  mustBeTerminal: [
    "session-stop 没查成: ENOENT: no such file or directory, lstat '/home/orca/mirasim-worktrees/windsurf-dao/dao-1024'",
    '账本没有仓 thoerwink8/windsurf-dao 分支 cc/escalate-key-ascii 的工人 job.dispatch——这不是派工链上的 PR，需人工打标',
    'reviewer-attach 失败：起审官会话没查成：execution profile unverified: codex-relay-gpt-5.6-sol',
    '仓 thoerwink8/windsurf-dao 分支 dao-1174 最新 job.dispatch 缺 repo——需人工打标',
    '找不到卡：path:/home/orca/mirasim-worktrees/windsurf-dao/dao-1152',
    'review-rounds-exceeded：PR #885 审查轮次 8/6，不起下一轮',
  ],
  mustBeRetryable: [
    'mirasim 起会话失败: worktree already has an active or unknown session',
    'reviewer-attach 失败：先让工人 rebase master，别派审官白审（mergeable=CONFLICTING）',
    'reviewer-attach 失败：mergeable=UNKNOWN——GitHub 还在算或没查成，不许当 MERGEABLE 放行',
    'reviewer-attach 失败：起审官会话没查成：连不上回环 ws',
    '删到一半停了：一棵都还没删；失败在 PR-#1159 审官：已经有 2 个会话进程在干活',
  ],
};
