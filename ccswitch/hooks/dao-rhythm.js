// dao 节律 hook — UserPromptSubmit · 在对话生命周期的合适时机注入 dao 行为指针
//
// 背景:规则系统(Cursor/Windsurf/Codex)只能表达"哪些规则附到哪些上下文",
// 无法表达"在对话的某个时机自动做某事"。时机驱动只有 hook 生命周期能做。
// 本 hook 扫描每条用户消息,在高置信信号出现时注入 ONE 短指针,把"靠 AI 记忆的软行为"
// 变成确定性触发。指针只指路(该做什么→走哪个 skill),不嵌流程(怎么做留给 skill)。
//
// 信号优先级(≤1 指针/回合):心跳唤醒 > 就绪播报 > 回顾 > 新建项目 > 收尾。
//   - WAKEUP(v1·2026-08-02 新增,dao 重写批 1-C):prompt 以 `[dao-heartbeat]` 开头
//     → 注入长窗留守四句 + 「醒来第一动作 Read ccswitch/rules/dao-longwindow.md §心跳对账节」。
//     签名侧由 dao-hard-gates.js 的 G6 硬闸保证(未签名的 ScheduleWakeup 直接 exit 2)。
//     **为什么排最高优先**,见下方 WAKEUP 段的三条理由(含它挤掉 READY 的那笔明账)。
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

// ── WAKEUP(v1·最高优先):心跳唤醒轮 → 注入长窗留守四句 + Read 指令 ──────────────
//
// **判据对「原始 prompt 的 trim」求值,不对 clean 求值,也刻意排在所有前置早退之前。**
// 理由:签名侧的闸在 dao-hard-gates.js G6,两边必须**逐字节同判**——闸放行的每一个 prompt,
// 这里都要认得出来。否则会出现「过了闸却没注入」这种最难查的静默失败(闸绿、注入无,
// 两边各自看都正常)。放在早退之前 = 不必论证「那几道早退对心跳恒不触发」,直接不给它机会。
//
// **为什么排最高优先(高于 READY)**,三条:
//   ① **精度**:`[dao-heartbeat]` 是显式签名,零歧义零误报;其余四套都是启发式正则。
//      让一个确定性信号给启发式信号让路是反的。
//   ② **时效**:心跳轮的正确第一动作是对账(补水位/在途盘点/铁序自查),这些判据**只有
//      这一轮用得上**;而心跳轮恰恰是留守四句唯一的投递时刻(dao.md 帅节长窗存根「投递通道」)。
//   ③ **被挤掉的那个是可延期的**:READY 是一次性元播报,它的消费者是「用户在场的那一轮」。
//
// 🔴 **明账:它确实会挤掉 READY,且在一种情形下是永久挤掉。** WAKEUP 命中即 inject+exit,
//    READY 段那一轮根本不执行 ⇒ 一次性标记**不会被烧**(只是推迟,不是丢失)。但若整段长窗
//    每一轮都是心跳轮,READY 就一轮都轮不上——而那正是用户不在场的时段,播报给谁看也没人读。
//    照直记在这里,不粉饰:这是取舍,不是「没想到」。
//
// **不做 per-session 去重**(与 SCAFFOLD/CLOSING 相反,那两个每会话只提醒一次):
//    留守四句要的就是**每一轮都到**。心跳轮之间隔着 900-1800 秒和一整批工具调用,
//    去重等于让第二轮之后的心跳全部裸奔,那正是本信号要治的病。
//
// 注入内容带签名 `[dao-rhythm WAKEUP v1]`:可达性矩阵靠 Grep transcript 里这个串取证,
// 而不是问 agent 本人「你收到了吗」(自陈不算证据)。
const HEARTBEAT_SIG = /^\[dao-heartbeat\]/;

if (HEARTBEAT_SIG.test(String(prompt).trim())) {
  inject(
    "【dao 节律·WAKEUP】[dao-rhythm WAKEUP v1]\n" +
    "醒来第一动作:Read `ccswitch/rules/dao-longwindow.md` §心跳对账节,按节内次序逐条对账。" +
    "该文件是全文真相源,下面四句只是压缩投影,冲突一律以该文件为准。\n" +
    "㈠心跳·防停摆:监督信号必须独立于作业信道——只靠 task-notification 驱动、任何一路将沉默即饿死整窗;" +
    "故心跳不许断(除了明确 stop:true 的那一轮),且**醒来先对账不凭印象**(在途任务查台账,不查记忆)。\n" +
    "㈡收官简报铁序:**简报先行**(先于心跳设置、作为独立完整消息发出)· **禁预记**(心跳 prompt 只准写未来动作," +
    "不准预记「已发」)· **ScheduleWakeup 永不作本轮最后一个工具调用**,其后必须再跟至少一个工具调用" +
    "(否则零在途+零待触发=循环饿死)。\n" +
    "㈢在途水位线:默认态是**多路满载**,单路在途是需要理由的例外——不是反过来;" +
    "**补水位排在本轮第一个工具段**,在任何 merge/裁决/抽验之前。" +
    "判据一句话:每个「不派」都要答得出「这一路为什么不能现在跑」,答不出就是水位缺口。\n" +
    "㈣自主边界(永不进自主窗):**不可逆决策**(架构定死/对外发布/删用户数据)· " +
    "**需用户在场件**(凭据/审美拍板/真钥)· **用户未点头的新疆域**——三格一律不进," +
    "只做「沿既定方向推进+健康维护」,转向权归用户。"
  );
}

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
    "与 docs/evolution/ 整个目录,再据实回答,勿凭记忆直接断言。" +
    "两类档要分别取:①两个 CSV(evolution-entries / evolution-lessons)用 dao-evolution skill 的 search.py;" +
    "②事故叙事档 incident-narratives-*.md 是 Markdown,search.py 不认它(它只读那两个 CSV),要直接 Grep/Read。"
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
