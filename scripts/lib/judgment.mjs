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

// 单条 review 的判定行 → { kind, red, green }（流转器用，比红项数更细）：
//   kind  = '判定'（首审）| '复核结论'（复核）| null（该 body 无判定行）
//   red   = 判定行里「红 N 项」的 N；判定行无红数且含「绿」→ green=true、red=null
//   判定行缺失（body 有内容但无判定行）→ kind=null、red=null、green=false
//   ——流转器对 kind=null 的 review 必须报帅（格式不符/没查成），不得自行猜红绿。
export function judgmentFromReview(body) {
  const firstLine = String(body || '').split(/\r?\n/).find(line => JUDGMENT_LINE_RE.test(line));
  if (!firstLine) return { kind: null, red: null, green: false };
  const kind = firstLine.match(JUDGMENT_LINE_RE)[1];
  let red = null;
  for (const match of firstLine.matchAll(RED_FLAG_PATTERN)) {
    red = Math.max(red ?? 0, Number(match[1]));
  }
  const green = red === null && /绿/.test(firstLine);
  return { kind, red, green };
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

// 供测试与 calibrate.mjs 引用正则本身（calibrate.tests.js 语义依赖）
export const JUDGMENT_LINE_RE_EXPORT = JUDGMENT_LINE_RE;
