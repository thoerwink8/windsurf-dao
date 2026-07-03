// dao 节律 hook — UserPromptSubmit · 在对话生命周期的合适时机注入 dao 行为指针
//
// 背景:规则系统(Cursor/Windsurf/Codex)只能表达"哪些规则附到哪些上下文",
// 无法表达"在对话的某个时机自动做某事"。时机驱动只有 hook 生命周期能做。
// 本 hook 扫描每条用户消息,在高置信信号出现时注入 ONE 短指针,把"靠 AI 记忆的软行为"
// 变成确定性触发。指针只指路(该做什么→走哪个 skill),不嵌流程(怎么做留给 skill)。
//
// 信号优先级(≤1 指针/回合):就绪播报 > 回顾 > 新建项目 > 收尾。
//   - RECALL(v1·稳定):回顾类提问 → 先搜 memory/evolution 再答。
//   - SCAFFOLD(v3·试验):新建/搭建意图 → 提醒先过 /dao-project-scaffold。
//     覆盖 dao-scaffold-check.js(SessionStart)跳过非 git 目录的盲区——
//     "还没 git init 的全新项目"这个更早的时间点，只有 UserPromptSubmit 能覆盖到。
//     判定标准(2026-07-02 用户定):说出动词就够,不必带"项目/仓库"宾语;
//     误触发防护从"宾语白名单"反转为"项目内部产物黑名单"(注入只是一句指路提示,宁滥勿漏)。
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
const RECALL_STRONG = /记得吗|还记得|遇到过吗|碰到过吗|有没有遇到|为什么当时|当初为什么|上个会话|之前的会话|当时怎么|当初怎么|之前怎么|怎么解决的/;
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

// ── SCAFFOLD(v3·试验):新建/搭建意图 → 提醒先过 /dao-project-scaffold ──
// 三层判定(2026-07-02 标准:动词即够,黑名单防误触):
//   1. STRONG:动词+项目级宾语(项目/仓库/工具/应用/网站/插件/库/包…)近距同现 → 必触发,黑名单不拦
//   2. VERB:动词出现且全句无内部产物词 → 触发(如"帮我新起一个"/"创建一下")
//   3. INTERNAL:组件/函数/文件/分支/环境/变量…在句中 → 视为项目内日常创建,不触发
const SCAFFOLD_STRONG = /(新建|新起|起个新|另起|搭建?|搭个|初始化|创建)[^。！？!?，,]{0,16}(项目|仓库|工具|应用|网站|站点|博客|平台|系统|插件|repo|app)|脚手架|\bscaffold\b|\bgit\s+init\b|\bbootstrap\s+(a\s+)?(new\s+)?(project|repo|app)\b|(create|start)\s+(a\s+)?(new\s+)?(project|repo(sitory)?|app|site|library|package|tool)|\bnew\s+repo(sitory)?\b/i;
const SCAFFOLD_VERB = /新建(?!议)|新起|起个新|另起|搭建|搭个|初始化|创建/;
const SCAFFOLD_INTERNAL = /文件|文件夹|目录|组件|函数|方法|接口|页面|路由|分支|标签|测试|用例|模块|脚本|命令|会话|窗口|弹窗|按钮|卡片|列表|表单|字段|索引|视图|文档|笔记|任务|工单|环境|变量|状态|配置|参数|数据库|一段|一行|hook|skill|rule|command|branch|file|folder|component|function|module|script|table/i;

const isScaffold =
  SCAFFOLD_STRONG.test(clean) || (SCAFFOLD_VERB.test(clean) && !SCAFFOLD_INTERNAL.test(clean));

if (isScaffold) {
  // per-session 去重(2026-07-03):对齐 CLOSING 的 sessMark 范式——一个会话最多提醒一次。
  // 实测教训:长自主会话里"创建/新建"动词高频出现,无守卫时每回合重复注入,噪音违反「太上不知有之」。
  const scaffoldMark = path.join(os.tmpdir(), "dao-rhythm", sessionId + ".scaffold");
  let scaffoldFirst = true;
  try { if (fs.existsSync(scaffoldMark)) scaffoldFirst = false; } catch (_) {}
  if (scaffoldFirst) {
    try { fs.mkdirSync(path.dirname(scaffoldMark), { recursive: true }); fs.writeFileSync(scaffoldMark, String(Date.now())); } catch (_) {}
    inject(
      "【dao 节律·新建项目】检测到新建项目/仓库意图——建议先执行 /dao-project-scaffold 确认目录结构规范," +
      "避免事后大规模重排(TraceyU project-structure-overhaul Loop 的教训:设计资产/生成物混杂容易积累成" +
      "\"看起来乱\"的债务)。(本提醒每会话仅一次)"
    );
  }
}

// ── CLOSING(v2·试验):强收尾信号 → 提醒 distill,每会话一次,并埋点 ──
// 仅最高置信收尾短语;显式不收 好了/完成/行了/OK/可以了(高歧义,可能是开始或中途确认)
const CLOSING = /收工|今天到这|今天先到这|今天就到这|今晚(先)?到这|先到这了?|睡了|睡觉|该睡|去睡|准备睡|晚安|下班了?|明天继续|明早继续|回头继续|改天继续|告一段落|就这样吧|收尾了|大功告成|全部搞定|都搞定了|我先撤|先撤了/;

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
