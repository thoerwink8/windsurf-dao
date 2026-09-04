#!/usr/bin/env node
// UserPromptSubmit hook —— 用户点破「你没接住/机制没解决」时，强制本轮走 admit-push。
//
// 为什么是 hook 而不是再写一条规矩（2026-09-04 用户拍板，grill-ai 落闸）：
// 「出错后必判机制」这条规矩此前有三层——CLAUDE.md 一行（层0）、memory 判例（层1）、
// 报帅单/审官必填栏（层2）。同一天连续四次失效，四次全靠用户点破。复盘判据一句话：
// **能生效的机制是别人查我，不是我查自己**——层2 里由审官执行的那半真咬到了（PR#873 判红），
// 靠我读规矩的层0/层1 一次没触发。所以层0/层1 已整层删除，换成这个 hook：
// 它每轮必然运行，不依赖我当时想不想得起来。
//
// 明确的能力边界（跟 admit-push skill 自己的坦白一致，不假装全覆盖）：
// 只认**用户说出口**的点破。用户没发现的漏，这里照样漏——那部分归审官闸（PR 路径）。
//
// 加载落点（2026-09-04 排查实证）：skills/<name>/hooks/hooks.json **不被 Claude Code 加载**
// ——上会话装在那里的闸一直是死的。现行落点是 ~/.claude/settings.json 的
// hooks.UserPromptSubmit（command 用绝对路径指到本文件；skill 目录是 symlink 直连仓内，
// 路径跟着仓走）。若 settings.json 被 cc-switch 下发覆写导致 hook 消失，重新加回即可。
//
// 判别性自测：node callout-detect.mjs --self-test（正反样本都在里面，改正则必须重跑）。

const PATTERNS = [
  // 「我之前说过 / 我不是说过」——用户在指认我漏掉了他已经拍过的事
  /我(之前|早就|上次|不是)?\s*(说过|讲过|提过|拍过|强调过)/,
  // 「你还是没 / 你又没 / 你没有承担」
  /你(还是|又|依然|仍然|并)?\s*(没有|没|不)\s*(承担|做到|固化|落实|解决|处理|执行|判|接住)/,
  // 「为什么又 / 为什么还」
  /为什么\s*(又|还|总是|老是)/,
  // 「机制问题 / 机制没解决 / 机制不完善」
  /机制\s*(问题|上的问题|层面)|机制(还)?\s*(不完善|没(有)?(被)?解决|没跟上)/,
  // 「没有被解决 / 这个问题本身没被解决」
  /(问题|事情|它)\s*本身\s*(没|未)/,
  // 「不是也要固化吗 / 不应该固化吗」
  /(也|不)\s*(要|应该|需要)\s*(彻底)?\s*固化/,
  // 「同样的错 / 又犯 / 重复犯」
  /(同样|一样|类似)的(错|问题).*(又|再)|又犯|重复犯/,
];

/** 纯函数：这条用户消息算不算「点破我没接住」。给 --self-test 与 hook 共用。 */
export function isCallout(text) {
  const s = String(text || '');
  if (!s.trim()) return false;
  return PATTERNS.some((re) => re.test(s));
}

const NOTICE = [
  '[承认即派·硬闸] 这条像是用户在点破「我没接住 / 机制没解决」。本轮必须做完这三步，不许只口头认账：',
  '  1. 说清这次漏的是哪一条、为什么没触发（执行失守还是制度缺失）。',
  '  2. 调用 admit-push skill 把它推进成一张单——不是改文档、不是写 memory 了事。',
  '  3. 若这是同方向第 2 次以上补丁，先走 grill-ai 落闸再动手。',
  '（本闸只认用户说出口的点破，防不住用户没发现的；那部分归审官必核清单。误判了就说一句「这条不是点破」跳过。）',
].join('\n');

function selfTest() {
  const YES = [
    '我之前说过应该马上派 subagent 去做',
    '你还是没有承担责任去给解决方案',
    '为什么又出现同样的问题',
    '我现在问的不是这个问题本身，而是这个问题本身没有被解决的机制问题',
    '不是这种问题也要彻底固化吗？',
    '这个机制还不完善吗',
    '同样的错又犯了一次',
  ];
  const NO = [
    '现状是什么',
    '继续',
    'mirasim 进展怎么样了',
    '你先研究下 mirasim linux 客户端是否有 orca 编排能力',
    '帮我把这批活派出去',
    '3 张 PR 盘面是什么',
    '我希望的是不会卡住',              // 提要求，不是点破
    '我想知道大致的进度',
  ];
  let bad = 0;
  for (const s of YES) if (!isCallout(s)) { console.log(`漏判（该拦没拦）：${s}`); bad += 1; }
  for (const s of NO) if (isCallout(s)) { console.log(`误判（不该拦却拦了）：${s}`); bad += 1; }
  console.log(bad === 0
    ? `自测通过：${YES.length} 条点破全拦下、${NO.length} 条日常全放行`
    : `自测失败：${bad} 条不对`);
  process.exit(bad === 0 ? 0 : 1);
}

if (process.argv.includes('--self-test')) selfTest();
else {
  // hook 路径独立兜底：任何异常都不许把用户锁住，也不许让宿主看见非零退出。
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    try {
      const j = raw.trim() ? JSON.parse(raw) : {};
      if (isCallout(j.prompt || j.user_prompt || '')) process.stdout.write(NOTICE + '\n');
    } catch { /* 读不到就静默放行——闸不许反过来卡住用户 */ }
    process.exit(0);
  });
  process.stdin.on('error', () => process.exit(0));
}
