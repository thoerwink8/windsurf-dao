// dao 节律 hook — UserPromptSubmit · 在对话生命周期的合适时机注入 dao 行为指针
//
// 背景:规则系统(Cursor/Windsurf/Codex)只能表达"哪些规则附到哪些上下文",
// 无法表达"在对话的某个时机自动做某事"。时机驱动只有 hook 生命周期能做。
// 本 hook 扫描每条用户消息,在高置信信号出现时注入 ONE 短指针,把"靠 AI 记忆的软行为"
// 变成确定性触发。指针只指路(该做什么→走哪个 skill),不嵌流程(怎么做留给 skill)。
//
// v1 只做 RECALL(回顾类提问→先搜 memory/evolution 再答)——最高值、最低噪音、dao.md 此前真空白。
// v2 将加 CLOSING(强收尾→提醒 distill,需实战调误触),见 docs/specs/auto-behavior-design.md。
//
// 设计要点(复用 dao-cn-title.js 范式):
//   - 以 / 开头且无实质内容 → 跳过
//   - strip 噪音后过短 → 跳过
//   - 任何异常 exit 0 优雅降级(只增不阻)
//   - ≤1 指针/回合;多数回合应静默(无信号即无动作,避免 context 污染)
//   - 原则:宁可漏报,不可滥报(高精度 > 高召回)
//
// 真相源:windsurf-dao/ccswitch/hooks/dao-rhythm.js
// 由 settings.json 的 UserPromptSubmit hook 调用。

const fs = require("fs");

let raw = "";
try { raw = fs.readFileSync(0, "utf8"); } catch (_) {}

let input = {};
try { input = JSON.parse(raw); } catch (_) {}

const prompt = String(input.prompt || "");

function done() { process.exit(0); }

// ── strip 噪音(复用 cn-title 范式)──
function strip(s) {
  return s
    .replace(/\[Image #\d+\]/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
const clean = strip(prompt);

// 无实质内容 / 纯 slash 命令(去命令后无内容)→ 跳过
if (!clean || clean.length < 4) done();
if (/^\//.test(clean)) {
  const rest = clean.replace(/^\/\S+\s*/, "").trim();
  if (!rest) done();
}

// ── RECALL 信号(T2 · 每次命中都触发)──
// 词干:需与疑问标记共现(滤掉"放到之前的位置"这类陈述句)
const RECALL_STEM = /之前|以前|上次|上回|当时|早先|历史上/;
// 强回顾:自带疑问语义,单独命中即可
const RECALL_STRONG = /记得吗|还记得|遇到过吗|碰到过吗|有没有遇到|为什么当时|当初为什么/;
// 疑问标记
const Q_MARK = /吗|呢|？|\?|是不是|有没有|为什么|为何|是否/;
// 英文回顾
const RECALL_EN = /\b(did|have)\s+we\b|\bremember\b|\blast time\b|\bpreviously\b/i;

const isRecall =
  RECALL_STRONG.test(clean) ||
  (RECALL_STEM.test(clean) && Q_MARK.test(clean)) ||
  RECALL_EN.test(clean);

if (!isRecall) done();

const context =
  "【dao 节律·回顾】这是回顾类提问——先搜 memory 索引(~/.claude/.../memory/MEMORY.md)" +
  "与 docs/evolution/*.csv(用 dao-evolution skill 的 search.py),再据实回答,勿凭记忆直接断言。";

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: context
  }
}));

process.exit(0);
