// scripts/lib/dispatch/same-class-scan.mjs —— 「同类扫描」段闸（审官标准第 10 条，2026-09-05 拍板）
//
// 改这段前必须知道：这条规则的起因是用户 2026-09-05 原话——「我不可能实时注意到……希望能有一个
// 机制主动发现不合理的地方」。实咬：闪窗修复本来只改了 3 处热点，用户点破后才扩到全仓 61 处（PR #928）。
//
// 本闸只管**机械可判**的那部分：修复类 PR 的正文里，「同类扫描」段在不在、有没有给出命令与输出。
// 「扫得对不对、结论站不站得住」是判断题，归审官（review-standard.md 第 10 条）——
// 机器拦「没写」，人拦「写得不对」，两层不重叠也不互相顶替。
//
// 三态必须分开（本仓通用判据）：
//   pass      —— 段在、命令在、输出在
//   violation —— 确证缺段/缺命令/缺输出（判红）
//   unscanned —— 正文没读成（null/undefined/读 PR 失败）。**没查成不许当 pass**，也不当 violation。
//   n/a       —— 不是修复类 PR，本闸不适用（这是「扫过了，确实不适用」，与没查成分开）

/** 修复类的机械判据：conventional commits 的 fix( 前缀，或标题里明写在修某个已发生的问题。 */
const FIX_TITLE_RE = /(^|\s)(fix|hotfix|revert)\s*[(:]|^\[[a-z]+\]\s*fix\b|修复|实咬|回归/i;

/** 段标题：允许 markdown 各级标题或加粗，认「同类扫描」四个字。 */
const SECTION_RE = /(^|\n)\s*(#{1,6}\s*|\*\*\s*)?同类扫描/;

/** 命令证据：正文里有围栏代码块，或有明显的命令行（grep/rg/node/git 开头的一行）。 */
const COMMAND_RE = /```[\s\S]*?```|(^|\n)\s*(grep|rg|node|git|py|python3?|findstr)\s+\S/;

/** 三种合法结论之一必须明写。 */
const CONCLUSION_RE = /全仓\s*\d+\s*处|只此一处|另有\s*\d+\s*处|扫不出来|无同类/;

/**
 * 判一份 PR 正文有没有交代「同类扫描」。
 * @param {{title?: string|null, body?: string|null, isFix?: boolean|null}} input
 *   isFix 显式给了就用给的（调用方另有判据时）；没给则从 title 机械推断。
 * @returns {{state:'pass'|'violation'|'unscanned'|'n/a', reason:string, missing?:string[]}}
 */
export function gateSameClassScan({ title, body, isFix } = {}) {
  if (body == null) {
    return { state: 'unscanned', reason: 'PR 正文没读成（不许当写过了，也不许当没写）' };
  }
  const text = String(body);
  const head = String(title ?? '');
  const fix = isFix == null ? FIX_TITLE_RE.test(head) : !!isFix;
  if (!fix) {
    return { state: 'n/a', reason: '不是修复类 PR（标题无 fix/修复/实咬/回归），第 10 条不适用' };
  }
  const missing = [];
  if (!SECTION_RE.test(text)) missing.push('「同类扫描」段');
  else {
    if (!COMMAND_RE.test(text)) missing.push('可复跑的扫描命令');
    if (!CONCLUSION_RE.test(text)) missing.push('三选一的结论（全仓 N 处 / 只此一处 / 另有 N 处本单不修）');
  }
  if (missing.length) {
    return {
      state: 'violation',
      missing,
      reason: `修复类 PR 缺${missing.join('、')}——审官标准第 10 条：修一处就交卷，同类问题换个地方再咬`,
    };
  }
  return { state: 'pass', reason: '同类扫描段齐全（段 + 命令 + 结论）' };
}
