// scripts/lib/judgment.mjs —— 判定行解析公共模块（唯一真相源，禁止复制两份）
//
// 口径来源 = issue #444 拍板 + calibrate.mjs 红项口径 v2 + 真实语料回归
// （tests/fixtures/reviews-446.json、reviews-440.json，tests/calibrate.tests.js 断言）。
// 本模块同时服务两个消费者，格式必须保持单一：
//   - scripts/calibrate.mjs —— 红项战绩测量（红项数 = 跨 review 判定行最大 N）
//   - scripts/flow.mjs      —— 闭环自动流转（判定行红/绿 + 完工 comment 识别）
// 谁想改判定格式，改这里一处；任何消费者不得在别处再写一份正则（自己查自己查不出错）。
//
// 判定格式（#444 实录）：审官以 COMMENT 提交 review，判定写正文首行，如
//   「判定：红 5 项」「**判定：红 3 项**」「复核结论：红 2 项」「复核结论：绿，可合并」。
// 判定行 = 行首为「判定」「复核结论」（允许 >、** 前缀）——正文叙述里引用他单
// 「红 N 项」不计入，防引用性多计（对抗审 #449 红 1）。

const RED_FLAG_PATTERN = /红\s*(\d+)\s*项/g;
const JUDGMENT_LINE_RE = /^\s*(?:[>*]\s*)*(判定|复核结论)/;

// 红项口径 v2：从 review 正文判定行提取红项数，跨全部 body 取最大 N。
// 复核绿（无红数）不清零首审红项；0 条 review 由调用方记 null（无审读 ≠ 0 红）。
export function redFlagsFromReviewBodies(bodies) {
  let max = 0;
  for (const body of bodies || []) {
    for (const line of String(body || '').split(/\r?\n/)) {
      if (!JUDGMENT_LINE_RE.test(line)) continue;
      for (const match of line.matchAll(RED_FLAG_PATTERN)) {
        max = Math.max(max, Number(match[1]));
      }
    }
  }
  return max;
}

// 单条 review 的判定行 → { kind, red, green, malformed }（流转器用，比红项数更细）：
//   kind      = '判定'（首审）| '复核结论'（复核）| null（该 body 无判定行）
//   red       = 判定行里「红 N 项」的 N；判定行无红数且含「绿」→ green=true、red=null
//   malformed = 判定行在但红绿都判不出（如「判定：红 项」缺数字、或「判定：绿/红」格式怪异）
//               ——流转器对 kind=null 或 malformed=true 的 review 必须报帅，不得自行猜红绿。
export function judgmentFromReview(body) {
  const firstLine = String(body || '').split(/\r?\n/).find(line => JUDGMENT_LINE_RE.test(line));
  if (!firstLine) return { kind: null, red: null, green: false, malformed: false };
  const kind = firstLine.match(JUDGMENT_LINE_RE)[1];
  let red = null;
  for (const match of firstLine.matchAll(RED_FLAG_PATTERN)) {
    red = Math.max(red ?? 0, Number(match[1]));
  }
  const green = red === null && /绿/.test(firstLine);
  return { kind, red, green, malformed: red === null && !green };
}

// 完工 comment 识别（流转器用）：工人完工的信号 = PR comment 首行命中
// 「完工」或「返工(完成|处置)」。真实语料（2026-08-14/15 实录）：
//   「## 完工报告」「## 完工自报（pi 工人，model/...）」「完工，转 ready。」
//   「## 对抗审返工处置（红 5 项全修，push ...）」「## 二轮返工完成，红 4 项逐条处置」
// 识别不了的非标准措辞当无信号（宁可漏报不误报动作——漏报由 24h 巡检兜底）。
export function isCompletionComment(body) {
  const firstLine = String(body || '').split(/\r?\n/).map(l => l.trim()).find(Boolean) || '';
  const stripped = firstLine.replace(/^#+\s*/, '');
  return /^完工/.test(stripped) || /返工(?:完成|处置)/.test(stripped);
}

// 审官标注行（#480 拍板：换人判据从数轮次改成审官标注驱动）。行首锚定，允许 >/** 前缀，
// 禁止搜全文——正文里引用的代码段含同样字样不得算标注（同 JUDGMENT_LINE_RE 的防骗口径）。
//   「上帅：<原因>」  = 质疑拍板/规格本身或需帅决策 → 流转器停手叫人（review 侧兜底，对应原生 escalation 消息）
//   「同一处未修好」  = 本轮红项与前几轮同一处反复 → 报帅换人信号（不自动换人，决策归帅）
//   「新引入」        = 本轮红项是新引入的问题 → 继续闭环（不触发换人信号）
export const SHANG_SHUAI_LINE_RE = /^\s*(?:[>*]\s*)*(上帅：)/;
export const SAME_SPOT_LINE_RE = /^\s*(?:[>*]\s*)*(同一处未修好)/;
export const NEW_INTRODUCED_LINE_RE = /^\s*(?:[>*]\s*)*(新引入)/;

// 单条 review 的标注 → { shangShuai, sameSpot, newIntroduced }：
//   shangShuai = 上帅原因文本（无原因行则 null）；sameSpot/newIntroduced = 布尔。
// 标注与判定行互相独立：上帅：行可以单独出现（不写判定行）。
export function reviewAnnotations(body) {
  let shangShuai = null;
  let sameSpot = false;
  let newIntroduced = false;
  for (const line of String(body || '').split(/\r?\n/)) {
    if (shangShuai === null) {
      const m = line.match(SHANG_SHUAI_LINE_RE);
      if (m) shangShuai = line.slice(m[0].length).trim() || '（未写原因）';
    }
    if (SAME_SPOT_LINE_RE.test(line)) sameSpot = true;
    if (NEW_INTRODUCED_LINE_RE.test(line)) newIntroduced = true;
  }
  return { shangShuai, sameSpot, newIntroduced };
}

// merge-policy 解析（#498 过渡垫片：派单时写在 worktree 卡备注里的合并权，流转器读它回填
// GitHub 标签 merge/auto）。格式（dao.mjs dispatchComment 产出）：
//   merge-policy:auto · model:X · reviewer:Y
// 字段锚定：行首或「·」/「,」/「;」分隔后，值只认 auto|manual。卡备注是自由文本，人覆写后
// 读不到 → null（安全默认：不打标签，落到等用户终审）。禁止搜全文——正文引用不算数。
export const MERGE_POLICY_FIELD_RE = /(?:^|[·,;]\s*)merge-policy\s*:\s*(auto|manual)(?=\s|$|[·,;])/;

// 单条卡备注的 merge-policy → 'auto' | 'manual' | null（读不到/格式不符）
export function mergePolicyFromComment(comment) {
  const m = String(comment || '').match(MERGE_POLICY_FIELD_RE);
  if (!m) return null;
  return m[1];
}

// 供测试与 calibrate.mjs 引用正则本身（calibrate.tests.js 语义依赖）
export const JUDGMENT_LINE_RE_EXPORT = JUDGMENT_LINE_RE;
