// dao 节律 hook — UserPromptSubmit · 在对话生命周期的合适时机注入 dao 行为指针
//
// 背景:规则系统(Cursor/Windsurf/Codex)只能表达"哪些规则附到哪些上下文",
// 无法表达"在对话的某个时机自动做某事"。时机驱动只有 hook 生命周期能做。
// 本 hook 扫描每条用户消息,在高置信信号出现时注入 ONE 短指针,把"靠 AI 记忆的软行为"
// 变成确定性触发。指针只指路(该做什么→走哪个 skill),不嵌流程(怎么做留给 skill)。
//
// 信号优先级(≤1 指针/回合):就绪播报 > 回顾 > 收尾。
//   - RECALL(v1·稳定):回顾类提问 → 先搜 memory/evolution 再答。
//   - CLOSING(v2·试验):强收尾信号 → 提醒 distill。每会话一次,并埋点到 _tmp/rhythm-closing.log。
//   - READY(v2 自报告):收尾样本攒够阈值 → 一次性播报"可验证调参",让仪器自己举手,
//     用户无需主动回忆何时该验证(太上不知有之)。
//
// 设计要点(复用 dao-cn-title.js 范式):以 / 开头无实质→跳过;strip 后过短→跳过;
//   任何异常 exit 0 优雅降级(只增不阻);多数回合静默(无信号即无动作,避免 context 污染)。
//   原则:宁可漏报,不可滥报(高精度 > 高召回)。
//
// 真相源:windsurf-dao/ccswitch/hooks/dao-rhythm.js
// 由 settings.json 的 UserPromptSubmit hook 调用。

const fs = require("fs");
const os = require("os");
const path = require("path");

// 项目根:本脚本在 <root>/ccswitch/hooks/ 下
const ROOT = path.resolve(__dirname, "..", "..");
const TMP_DIR = path.join(ROOT, "_tmp");
const LOG_FILE = path.join(TMP_DIR, "rhythm-closing.log");   // 收尾埋点(耐久观测数据)
const READY_MARK = path.join(TMP_DIR, ".rhythm-v2-announced"); // 就绪已播报(一次性)
const CLOSING_THRESHOLD = 12;  // 攒够多少条收尾样本即播报"可验证"

let raw = "";
try { raw = fs.readFileSync(0, "utf8"); } catch (_) {}

let input = {};
try { input = JSON.parse(raw); } catch (_) {}

const prompt = String(input.prompt || "");
const sessionId = String(input.session_id || "nosid");

function inject(context) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context }
  }));
  process.exit(0);
}
function done() { process.exit(0); }

function strip(s) {
  return s.replace(/\[Image #\d+\]/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
const clean = strip(prompt);

if (!clean || clean.length < 4) done();
if (/^\//.test(clean)) {
  const rest = clean.replace(/^\/\S+\s*/, "").trim();
  if (!rest) done();
}

// ── READY 自报告(最高优先,一次性):收尾样本攒够 → 让仪器自己举手 ──
try {
  if (!fs.existsSync(READY_MARK) && fs.existsSync(LOG_FILE)) {
    const n = fs.readFileSync(LOG_FILE, "utf8").split(/\r?\n/).filter(Boolean).length;
    if (n >= CLOSING_THRESHOLD) {
      try { fs.mkdirSync(TMP_DIR, { recursive: true }); fs.writeFileSync(READY_MARK, String(Date.now())); } catch (_) {}
      inject(
        "【dao 节律·v2 验证就绪】dao-rhythm 收尾信号(CLOSING)已积累 " + n + " 条样本(_tmp/rhythm-closing.log)。" +
        "请向用户报告:可复盘误触率、按假阳性调正则、决定 CLOSING 转正/回退。"
      );
    }
  }
} catch (_) {}

// ── RECALL(v1·稳定):回顾类提问 → 先搜 memory/evolution 再答 ──
const RECALL_STEM = /之前|以前|上次|上回|当时|早先|历史上/;
const RECALL_STRONG = /记得吗|还记得|遇到过吗|碰到过吗|有没有遇到|为什么当时|当初为什么/;
const Q_MARK = /吗|呢|？|\?|是不是|有没有|为什么|为何|是否/;
const RECALL_EN = /\b(did|have)\s+we\b|\bremember\b|\blast time\b|\bpreviously\b/i;

const isRecall =
  RECALL_STRONG.test(clean) || (RECALL_STEM.test(clean) && Q_MARK.test(clean)) || RECALL_EN.test(clean);

if (isRecall) {
  inject(
    "【dao 节律·回顾】这是回顾类提问——先搜 memory 索引(~/.claude/.../memory/MEMORY.md)" +
    "与 docs/evolution/*.csv(用 dao-evolution skill 的 search.py),再据实回答,勿凭记忆直接断言。"
  );
}

// ── CLOSING(v2·试验):强收尾信号 → 提醒 distill,每会话一次,并埋点 ──
// 仅最高置信收尾短语;显式不收 好了/完成/行了/OK/可以了(高歧义,可能是开始或中途确认)
const CLOSING = /收工|今天到这|今天先到这|今天就到这|先到这了?|睡了|睡觉|该睡|下班了?|明天继续|明早继续|告一段落|就这样吧|收尾了|大功告成|全部搞定|都搞定了/;

if (CLOSING.test(clean)) {
  const sessMark = path.join(os.tmpdir(), "dao-rhythm", sessionId + ".closed");
  let firstThisSession = true;
  try { if (fs.existsSync(sessMark)) firstThisSession = false; } catch (_) {}
  if (firstThisSession) {
    // 埋点:记录触发样本供日后复盘误触率(hook 无法判断"是否真收尾",只记录,审阅靠人)
    try {
      fs.mkdirSync(TMP_DIR, { recursive: true });
      const line = new Date().toISOString() + "\t" + sessionId + "\t" + clean.slice(0, 80).replace(/\t/g, " ") + "\n";
      fs.appendFileSync(LOG_FILE, line);
    } catch (_) {}
    try { fs.mkdirSync(path.dirname(sessMark), { recursive: true }); fs.writeFileSync(sessMark, String(Date.now())); } catch (_) {}
    inject(
      "【dao 节律·收尾】本会话若产生过真洞察(踩坑/推翻假设/新模式)→走 dao-evolution 三层路由沉淀;" +
      "纯执行无洞察则跳过,勿为沉淀而沉淀。"
    );
  }
}

// 无信号 → 静默
process.exit(0);
