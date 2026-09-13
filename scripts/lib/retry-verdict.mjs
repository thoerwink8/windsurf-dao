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
  ],
  mustBeRetryable: [
    'mirasim 起会话失败: worktree already has an active or unknown session',
    'reviewer-attach 失败：先让工人 rebase master，别派审官白审（mergeable=CONFLICTING）',
    'reviewer-attach 失败：mergeable=UNKNOWN——GitHub 还在算或没查成，不许当 MERGEABLE 放行',
    'reviewer-attach 失败：起审官会话没查成：连不上回环 ws',
    '删到一半停了：一棵都还没删；失败在 PR-#1159 审官：已经有 2 个会话进程在干活',
  ],
};
