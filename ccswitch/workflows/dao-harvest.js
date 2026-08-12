export const meta = {
  name: 'dao-harvest',
  description: '好实践收割(参数化):从会话记录/PR/工作面板/用户意图账本里捞「做对了但没人固化」的实践,按升格三判据预筛 → 去重对抗核验 → 产出可直接粘贴的条款原文 + 归属层判断',
  // ⚠ 本字段必须是**单个字符串字面量**——Workflow 工具校验 meta 为纯字面量，
  // 字符串 `+` 拼接是 BinaryExpression，会被整脚本拒载（2026-08-01 实测报
  // "meta must be a pure literal: non-literal node type in meta: BinaryExpression"）。
  whenToUse:
    '需要 args: {repoPath}(必填,不设默认——跨项目资产不该内置某一个仓的路径)。可选 args: {sources:[...], sessionLogDir, taskOutputDir, workboardFile, intentLogFile, clauseFile, daoFile, daoRulesDir, since, extraSignals:[...], goal, model, verifyModel}。何时跑:①窗口收官段(设计定的强制触发点)②`verify-all` 的收割计数观察线提示「距上次收割 ≥N 个 PR」时③刚结束一批多 agent 并行、交付报告里明显有「我超出要求做了 X」「我拒绝了派单令要求的 Y」这类痕迹时。解的问题:坏经验有天然触发器(出事了/返工了/被骂了——有痛感),好经验没有,做对的事做完就过去了。⚠ **它只覆盖好实践的「单次叙事」半边**(某次某个官在某个岔路口选对了),**「量化聚合」半边由 `pr-history-postmortem` 覆盖**(N 个 PR 都有某个毛病这类只在把全史排成一列后才存在的模式)。两个都跑才拿得到完整候选面:2026-07-27 首轮实测,本 workflow 的 10 条与量化手工版的 7 条**重合度为 0**——互不相交而非子集关系,因为两类模式在对方的取数对象里结构上不可见。连带效应:量化聚合天然产出**形态类**候选(能被计数就意味着有可机械识别的特征,那特征本身就是机检判据),单次叙事天然产出**判断类**(一次判断之所以是判断,正因为它没有可机械识别的特征)。故只跑本 workflow 会看到 `is_form=true` 占比很低,**那是分工使然,不是收割失效**。设计出处见 dao 仓的生长闭环设计文档(windsurf-dao `docs/specs/dao-growth-loop.md` §二①,2026-08-02 由 mousse-cli docs/ops/ 迁入)。',
  phases: [
    { title: '收割', detail: '按源并行:会话记录/PR 与 commit/工作面板/用户意图账本' },
    { title: '核验', detail: '逐条对抗核验:先判重(已有同类即毙),再复核三判据与归属层' },
  ],
}

// `args` 可能以调用方原始 JSON 字符串形式到达,也可能已是解析好的对象,视运行时而定——
// 两种形态都归一化处理。不是合法 JSON 的字符串原样落回,交给下方必填校验去报错。
const ARGS = typeof args === 'string'
  ? (() => { try { return JSON.parse(args) } catch (e) { return args } })()
  : args

const REPO = ARGS && ARGS.repoPath
if (!REPO) {
  throw new Error(
    'dao-harvest workflow requires args: {repoPath: "<仓库绝对路径>"}。' +
    '刻意不设仓库默认值——它是 dao 级跨项目资产,内置某一个仓的路径正是 workflow 不可复用的根因' +
    '(同 pr-history-postmortem 的取舍)。'
  )
}

const ALL_SOURCES = ['transcript', 'pr-commit', 'workboard', 'intent-log']
const PICKED = (ARGS && Array.isArray(ARGS.sources) && ARGS.sources.length) ? ARGS.sources : ALL_SOURCES
const unknownSrc = PICKED.filter(k => !ALL_SOURCES.includes(k))
if (unknownSrc.length) {
  throw new Error(`未知收割源:${unknownSrc.join(', ')}；合法值:${ALL_SOURCES.join(' / ')}`)
}

const DIG_MODEL = (ARGS && ARGS.model) || undefined          // 缺省由 harness 决定档位
const VERIFY_MODEL = (ARGS && ARGS.verifyModel) || 'sonnet'
const CHUNK = 6                                              // 单个核验官一次最多接几条候选

// Claude Code 把每个项目的会话记录放在 `~/.claude/projects/<slug>/`,slug 由项目绝对路径
// 逐字符替换非字母数字为 `-` 得到(如 `D:\frank\mousse-cli` → `D--frank-mousse-cli`)。
// 这是**观测得来的近似规则**,不是公开契约:两个方向都可能失配(harness 换算法即失效;
// 含 Unicode 的路径未验证)。故 sessionLogDir / taskOutputDir 都可由 args 直接覆盖,
// 且下方 prompt 要求 agent **先 ls 确认目录真的存在**,不存在就如实报「该源不可达」而非硬凑。
const SLUG = REPO.replace(/[^A-Za-z0-9]/g, '-')
const SESSION_LOG_DIR = (ARGS && ARGS.sessionLogDir) || `~/.claude/projects/${SLUG}`
const TASK_OUTPUT_DIR = (ARGS && ARGS.taskOutputDir) || `%TEMP%/claude/${SLUG}/<session-uuid>/tasks`

// workboardFile **刻意无硬缺省**(2026-08-01 改)。原缺省是 `docs/ops/WORKBOARD.md`,而下方 prompt
// 的回退判据写的是「不存在则 Glob 同类看板」——该判据对一个**仍存在但已冻结**的文件恒假:
// 调用方仓库 2026-08-01 把活账迁去 issue 区/看板后,那个文件退役为历史存档却**没有删**,于是
// 回退永不触发、这一路静默去读一份历史快照并返回零候选(失效形态是「零候选」而不是报错)。
// 缺省改为交给 agent 按序探测(见下方 WORKBOARD_SRC),并要求它**读到文件先看有没有退役字样**——
// 「文件在不在」不足以判断「它还是不是现役承接物」。显式传 workboardFile 则直接用,不再探。
const WORKBOARD = (ARGS && ARGS.workboardFile) || null
const WORKBOARD_SRC = WORKBOARD
  ? `:\`${REPO}/${WORKBOARD}\`(调用方显式指定,直接读它)。`
  : `——**调用方未指定 \`workboardFile\`,按序自行探测**:
  ①**先探 issue 区/看板**(GitHub-backed 项目的现役承接物,活账在这里):\`gh issue list --state open --limit 100\`、以及 \`gh project list\` / \`gh project item-list <n>\` 看有没有观测中心型看板。取到就以它为本路的源。
  ②取不到(非 GitHub 项目 / 无 gh 凭据 / 仓库无 issue 区)再 Glob \`${REPO}/docs/ops/*.md\` 找问题树/看板型仓内文件。
  ③🔴 **捞到文件先读头部十几行看有没有「已退役 / 历史存档 / 不要再往本文件挂新问题」类字样**——有就当**历史快照**读(可补收旧账,但必须在 \`source_health.note\` 里写明"读的是已退役快照"),**不得当现役面板**。「文件存在」不等于「它还是现役承接物」:2026-08-01 实证,某仓的问题树面板退役后文件仍在,使旧的「不存在则回退」判据恒假、本路静默返回零候选。
  ④以上都不可达就判**该源不可达**并在 \`source_health\` 里写清你探了哪几步,**别硬凑**。`
const INTENT_LOG = (ARGS && ARGS.intentLogFile) || 'docs/user-intent-log.md'
const CLAUSE_FILE = (ARGS && ARGS.clauseFile) || 'docs/rules/dispatch-clauses.md'
const DAO_FILE = (ARGS && ARGS.daoFile) || 'D:/frank/windsurf-dao/ccswitch/dao.md'
// ⚠️ dao 常驻场域的**判重扫描面不止 dao.md 一个文件**(2026-08-01 起):长窗自主排程 ①-⑥.5 已迁到
// `ccswitch/rules/dao-dispatch.md` §七,dao.md 那一段只剩一行指针。只 Grep dao.md 会让那整段判据落在
// 扫描面之外 ⇒ 收割官把「其实早就有了」的东西重新发明一遍,而 `is_new=true` 看起来完全正常
// ——这正是 dao.md 反·归讲的「扫描面静默塌陷:检测器数到 0 个违例,和检测器根本没看到样本,输出一模一样」。
// 故判重提示里同时给出 dao.md 与 rules/ 目录;后者用目录而非枚举文件,是为了以后再迁出别的节时不用回来改这里。
const DAO_RULES_DIR = (ARGS && ARGS.daoRulesDir) || 'D:/frank/windsurf-dao/ccswitch/rules/'
const DAO_SCAN = `\`${DAO_FILE}\`(dao 常驻场域正文) 与 \`${DAO_RULES_DIR}\` 下全部 .md(由 dao.md 存根指出去的细则正文,如长窗排程)`

const sinceLine = (ARGS && ARGS.since)
  ? `本次收割范围:${ARGS.since} 之后的产出。`
  : `本次收割范围未由调用方指定 —— 默认**最近一个工作窗**:先按修改时刻排序找出最新的会话记录/最近合并的 PR,` +
    `再据此判断窗口边界并在 summary 里写明你实际覆盖的时间区间(禁含糊,后续收割要靠这个区间续接)。`

const goalLine = (ARGS && ARGS.goal)
  ? ARGS.goal
  : '把「做对了但只停在项目层、没进 dao 体系」的实践捞出来,变成可直接粘贴的条款候选。' +
    '**不是找缺陷**(那是 pr-history-postmortem / incremental-review 的活),是找**已经被做对的事**。'

const extraSignals = (ARGS && Array.isArray(ARGS.extraSignals) && ARGS.extraSignals.length)
  ? ARGS.extraSignals
  : []

// ── 好实践的信号词表 ────────────────────────────────────────────────────────────
// 这些词是**捞取入口**,不是判据:命中只说明"这里可能有故事",值不值得升格仍要过三判据。
// 表本身两个方向都不完备:换个人写交付报告可能一个词都不用(漏),而"顺带"之类的词也
// 大量出现在与好实践无关的语境里(噪音)。故 prompt 要求 agent 命中后**读上下文再判**。
const SIGNAL_WORDS = [
  '超出要求', '超出派单', '做得对', '做对的一件事', '值得记', '值得固化',
  '拒绝', '没顺着', '不静默偏离', '抓出', '证伪', '前提不成立',
  '未尽处', '自曝', '顺带', '反而', '零发现也是', '如实标注', '判不了',
  ...extraSignals,
]

const COMMON = `【身份与红线】你是 workflow subagent,回答对象是编排器,不是用户——禁止调用 AskUserQuestion,直接返回结构化结果。只读:不写不改任何文件、不 commit、不动配置(发现问题也只记录)。
【工具】搜索用内置 Grep/Glob,读文件用 Read(大文件必须带 offset/limit 分段)。**允许用 Bash 跑 \`gh\` CLI、\`git log\`、以及 \`ls\` 类目录探测**(内置工具做不到),但仍禁止用 shell 跑 grep/find/cat/tail/Select-String 做文本搜索或一次性读大文件。
【仓库】${REPO}。${sinceLine}
【本轮目标】${goalLine}

【升格三判据(每条候选都必须逐条作答,不许含糊)】
1. \`cross_project\` —— **跨项目适用**:换个技术栈/换个项目还成立吗?依赖某个具体文件名、某个框架、某个仓的目录结构 ⇒ false。
2. \`evidence\` —— **有实证**:这事是**做出来并验证过的**,不是想出来的。必须给可复核锚点(文件+行 / PR 编号 / commit hash / 会话记录里的原话片段)。**填不出具体出处即视为 evidence 不成立,该条降级为「不值得进」**。
3. \`is_form\` —— **是形态不是判断**:存在一个「不需要自由裁量就必然到达」的时刻使它被执行吗?能挂在派单模板首行 / 机检脚本 / PR 流程 / 权限 deny / workflow schema 上 ⇒ true;只能靠"读到了就该照做" ⇒ false。
   **这是硬门槛**:调用方仓库实测形态类携带率 100%、判断类 9-24%。\`is_form=false\` 的条目**仍可提交**(判据层在事后核验与争议裁定里独立有用),但必须在 \`trigger\` 里填 \`无\` 并在 clause_text 同行标 \`[仅判据·无触发]\`,**不许假装它会改变行为**。

【产出形态(两件,缺一不算完成)】
A. \`clause_text\` —— **可直接粘贴的条款原文**,一行,格式:
   \`- **<判据名>**:<一句话判据>(<出处>)。 [n=<复发次数> @<首次入库月日,即今天> 触发:<触发点>]\`
   元字段语义以 \`${REPO}/${CLAUSE_FILE}\` 的「条款元字段」节为准(先读那一节再动笔)。\`n\` 取**下界**(只数得出出处里明写的次数),数不出写 \`n=1\`。
B. \`layer\` —— **该放哪层**:\`dao.md\`(跨项目且属帅位/道层心法) / \`clause-common\`(条款库通用节) / \`clause-implementer\` / \`clause-verifier\` / \`clause-recon\` / \`clause-dogfood\` / \`clause-review\`(条款库对应官种节) / \`project-rules\`(只对本项目有意义) / \`not-worth\`(不值得进,写清为什么)。
   判据同 dao「知识归位」:换个项目还能用 → dao 层;只在当前技术选型下有意义 → 项目层。犹豫时倾向全局,但 \`not-worth\` 是**正常且必要的裁定**,不是失败。

【去重(本 workflow 最容易产出噪音的地方,硬要求)】
每条候选在提交前必须做一次判重,并把过程写进 \`dedup_checked\`:
  - Grep \`${REPO}/${CLAUSE_FILE}\`(条款库全文)找同类判据
  - Grep ${DAO_SCAN} 找同类判据 —— **两处都要扫**:dao.md 里是存根的那些节,正文在 rules/ 下,只扫 dao.md 会漏掉整段
  - 命中同类 ⇒ 两种处置:①**完全重复** → layer 填 \`not-worth\`,\`dedup_checked\` 写明命中哪一条;②**已有条款但本次实证是新的一例** → 不新立条款,改为提案「给已有条款的 \`n=\` +1 并补一句出处」,在 clause_text 里写成对既有条款的**修订**而非新增,并注明被修订条款的原文首句。
  - \`dedup_checked\` 为空或只写"查过了"的候选,核验阶段一律判不通过。

【禁】
- 禁笃定措辞(「已全覆盖」「无遗漏」「此后任何 X 都被 Y」):近似手段如实标注为近似,并写明两个方向都构造得出反例。
- 禁把**帅/编排侧自己的话**当实证:帅在会话里说"这做得对"只是线索,实证要落到代码/测试/PR/commit 那一侧可复核的东西上。
- 禁凑数:一个源上真的没有可升格的,就在 \`source_health\` 里写 \`yield: "零"\` 并说明你扫了什么、为什么判空。**零收割是合格交付**——空源的信息(以后要不要精简收割源)与满源同等有用。
- 禁把「这次修的那个 bug」当好实践:修 bug 属坏经验路径(已有触发器),本 workflow 只收**做对的事**与**做对之后总结出的做法**。
- **禁自造量化论断**:形如「N 个 PR 都有某个毛病」「合规率从 X 掉到 Y」这类**聚合模式**不在本 workflow 的取数对象里(它们只在把全史排成一列后才存在),要它们请另跑 \`pr-history-postmortem\`。你若在本轮凭手头几个样本推出一个聚合比例,那是过度解读——**顶多在 summary 里写一句「疑似聚合模式,建议另跑量化那一路核实」,不进 candidates**。`

const CANDIDATES = {
  type: 'object', required: ['summary', 'source_health', 'candidates'],
  properties: {
    summary: { type: 'string', description: '一段话:实际覆盖的时间区间 + 扫了什么 + 总体判断' },
    source_health: {
      type: 'object', required: ['source', 'yield', 'scanned', 'note'],
      properties: {
        source: { type: 'string', description: '本路源名' },
        yield: { type: 'string', enum: ['富矿', '中等', '稀薄', '零'] },
        scanned: { type: 'string', description: '具体扫了哪些文件/命令/多少条目,给可复核数字' },
        note: { type: 'string', description: '判为该等级的理由;若为「零」必须说明是源本身空、还是取数路径不可达(两者处置不同)' },
      },
    },
    candidates: {
      type: 'array', items: {
        type: 'object',
        required: ['practice', 'evidence', 'cross_project', 'is_form', 'trigger', 'clause_text', 'layer', 'dedup_checked', 'confidence'],
        properties: {
          practice: { type: 'string', description: '一句话说清「谁在什么时刻做对了什么」' },
          evidence: { type: 'string', description: '可复核锚点:文件+行 / PR 编号 / commit hash / 会话原话片段。填不出即该条不成立' },
          cross_project: { type: 'boolean' },
          is_form: { type: 'boolean' },
          trigger: {
            type: 'string',
            description: '挂在哪个必经动作上;取值同条款库 触发: 字段(模板首行/权限deny/verify-all/PR流程/分类器拦截/workflow-schema/无)。答不出填「无」',
          },
          clause_text: { type: 'string', description: '可直接粘贴的条款原文,含 [n= @ 触发:] 元字段' },
          layer: {
            type: 'string',
            enum: ['dao.md', 'clause-common', 'clause-implementer', 'clause-verifier', 'clause-recon', 'clause-dogfood', 'clause-review', 'project-rules', 'not-worth'],
          },
          dedup_checked: { type: 'string', description: '判重过程:Grep 了哪些文件/什么关键词/命中什么。空或含糊即核验不通过' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
  },
}

const VERDICT = {
  type: 'object', required: ['overall', 'verdicts'],
  properties: {
    overall: { type: 'string' },
    verdicts: {
      type: 'array', items: {
        type: 'object', required: ['practice', 'is_new', 'criteria_hold', 'layer_agreed', 'pass', 'reason'],
        properties: {
          practice: { type: 'string' },
          is_new: { type: 'boolean', description: '独立判重结论:条款库/dao.md 里真的没有同类吗' },
          criteria_hold: { type: 'boolean', description: '三判据取值是否与你独立复核一致(尤其 evidence 锚点真实存在、is_form 没被高报)' },
          layer_agreed: { type: 'string', description: '你同意的归属层;与提交值不同则写出你的值与理由' },
          pass: { type: 'boolean' },
          reason: { type: 'string', description: '附独立证据锚点(文件+行/命令+真退出码),禁「看起来没问题」类模糊措辞' },
        },
      },
    },
  },
}

const SOURCE_DEFS = {
  'transcript': {
    prompt: `
【源】**会话记录(本轮最富矿的一路,也是唯一能拿到 subagent 交付报告原文的一路)**。

⚠ **取数路径的实测校正(2026-07-27,别照旧认知找)**:
- **subagent 的交付报告不在 \`tasks/*.output\` 里**。那个目录装的是:①后台 bash 命令输出(纯文本,文件名多以 \`b\` 开头)②workflow 运行日志(多以 \`w\` 开头,单个可达 100-200KB)③以 agentId 命名的 sidechain 转写(多以 \`a\` 开头)——但实测**正常结束的 agent 对应文件为 0 字节**,只有异常/被接续过的才有内容。所以把它当交付报告来源会得到一个几乎空的源。
- **交付报告实际在主会话记录里**:\`${SESSION_LOG_DIR}/<session-uuid>.jsonl\`,以 Agent/Task 工具的 \`toolUseResult\` 形式落在主会话流里(帅读到的那份原文)。这个文件极大(实测单个可达数十 MB),**禁全量读**。
- 参考路径:\`${TASK_OUTPUT_DIR}\`(仍值得扫一眼,workflow 日志里有对抗核验官的裁定原文)。
- **两条路径都先 \`ls\` 确认存在**;不存在就在 source_health 里写 \`yield: "零"\` 并注明「取数路径不可达」(与「源本身空」是不同结论,处置也不同)。

【已验证可用的提取手法(照做,别自己发明)】
用内置 Grep 的 \`-o\`(only-matching) + **有界窗口**正则,把命中处连上下文一并截出来,既不用读整行(单行可达数 MB)也不会触发工具的「long line omitted」:
  pattern: \`.{0,30}(信号词A|信号词B).{0,150}\`
  output_mode: content, \`-o\`: true, \`-n\`: false, head_limit: 20~30
**窗口要小**:实测 \`.{0,80}...{0,260}\` 会大量返回「Omitted long matching line」而看不到内容,\`.{0,30}...{0,150}\` 正常返回。要更多上下文就**对同一信号词换更具体的关键词再打一枪**,不要放大窗口。

【信号词(捞取入口,不是判据——命中后必须读上下文再判)】
${SIGNAL_WORDS.map(w => '\`' + w + '\`').join(' · ')}

要回答:
1. **官超出要求做对的事**:交付报告里形如「我顺带做了 X」「我把取舍钉成会变红的断言」「我自主补了 X 因为 Y」的段落。每条要能说清「派单令只要求到哪、它多做了什么、为什么那个多做是对的」。
2. **官拒绝了错误指令的事**(升格价值通常最高):形如「派单令要求 X,我查码发现 X 结构上不可达/覆盖不了它自己举的例,故不做 X 而是 Y,并把射程边界写进文件头」。这类的可升格判据往往是「**发现要求不可满足时停手报告而非编造以满足**」。
3. **官自曝的未尽处**:凡交付里主动列了欠账/局限/「我认为哪里最可能出问题」的,看它**自曝的方式**里有没有可复用形态。
4. **核验官/复审官的裁定手法**:mutation 两态、负控组、基线活性验证、判别力自检问句等,有没有本轮**新出现**的手法(已在条款库里的走判重)。
5. **帅自己做对的事**:同样收,但按【禁】里那条——帅的自我评价只是线索,实证要落到可复核那一侧。

**取数省 token 的次序**:先用 2-3 个高特异性信号词打头阵(如 \`拒绝\`+\`结构上\`、\`超出要求\`),看命中密度,再决定要不要把整张信号词表跑完。不要一开始就把 20 个词一次性 or 起来——那会返回大量与好实践无关的命中。`,
  },
  'pr-commit': {
    model: 'sonnet',
    prompt: `
【源】**PR body 与 commit message**。这是「好经验被写下来了、但只写在项目层」的最典型停留处。

方法:
1. \`gh pr list --state all --limit 40 --json number,title,body,mergedAt\`(在 ${REPO} 下跑;\`gh\` 不可用或未登录就降级为纯 git 分析并在 source_health 里说明)
2. \`git -C ${REPO} log -n 40 --format='%h %s%n%b%n---'\` 读 commit body。**本仓的 commit body 常有长篇取舍论证,那里面的方法论往往比 PR body 更浓**。

要回答(每条给 PR 编号或 commit hash):
1. **PR body / commit body 里被论证过的做法**:形如「为什么不选候选 B」「近似判据一律 severity=info 并加(建议)前缀,两个方向的反例都写进 why」「清单化的副产品是暴露缺口」这类——**做法本身可跨项目复用,却只活在这一个 commit 里**。
2. **修一个病时顺带立下的通用规矩**:如「不维护清单而扫目录,手维护的清单会过期」——判据是通用的,载体是本仓的。
3. **PR body 的「未做到/已知缺口」段**里有没有**自曝的方式本身**值得固化(如「近似手段如实标注 + 两向反例」)。
4. **显式拒绝的加法**:commit 里写明「候选 X 不收,理由 Y」的——**不收的理由常比收的理由更可复用**(为道日损)。
5. 若本仓有 CHANGELOG/PROGRESS 类账本,扫一眼有没有「做法级」而非「功能级」的条目;账本以流水为主,通常稀薄,**判稀薄就直说**。`,
  },
  'workboard': {
    model: 'sonnet',
    prompt: `
【源】**工作面板的「过程中新发现」段**${WORKBOARD_SRC}

背景:编排侧已经在往那里挂「官做对的一件事」「官抓出帅方案漏洞」「官自曝的未尽处」——**这是本闭环里唯一已经在运转的收割动作**,但它挂完就停在项目文档里,没有下一跳。你这一路就是那个下一跳。

方法:整篇读(这类面板通常几百行,可直接 Read),重点看:
1. \`🆕\` 标记的行 —— 挖某方向时顺带冒出来的
2. \`⚠\`/\`🔴\` 标记里**属于「做对了」而非「出事了」**的部分(两者混在同一段里,要分开)
3. 「官自曝」「官拒绝」「官抓出」「核验官指出」开头的条目
4. \`⏸ 挂账\` 表:挂账**写清原因与解冻条件**这个做法本身若还没进 dao,它是候选

要回答:
1. 面板上哪些条目是**已被记录的好实践但尚未升格**(逐条给行号)
2. 其中哪些的判据可以脱离本项目的具体对象(去掉文件名/功能名后还剩下什么)
3. **面板自身的形态**有没有可升格处(如「新问题随时往对应方向下挂 = 不搁置的物理保证」「完成判据从『到点了』改为『这个方向的树清空了』」)——注意这类元层面的候选很容易与已有 dao 条款重合,判重要格外仔细`,
  },
  'intent-log': {
    model: 'sonnet',
    prompt: `
【源】**用户意图账本**:\`${REPO}/${INTENT_LOG}\`(不存在则 Glob \`${REPO}/docs/*intent*\` / \`${REPO}/docs/*用户*\`;都没有就判该源不可达并说明——这个源是可选形态,不是每个项目都有)。

这一路的逻辑与其他三路**相反**:它记的是**用户纠正**,而每条纠正都指向一个当时没做到位的地方。**好实践藏在纠正之后的改法里**,不在纠正本身。
例:用户说「我不会去 GitHub 频繁看」⇒ 纠正的是"可视化价值"这个论据 ⇒ 可升格的是「**论证一个方案前先问清受众真的会不会看,否则整条论据链无效**」。

要回答:
1. 逐条读 🔵已实施 / 🟢已落档 两类,提取**改法里的可复用判据**(不是用户原话本身——用户原话是本项目的需求,判据才是跨项目的)
2. ⚪已否决类:**否决的理由**往往是最干净的跨项目判据(如「让一个 50 行脚本项目也建 issue 队列是纯负担」⇒ 机制必须带机器可判的适用性判据)
3. 🟡待展开类:**不要**当好实践收——那些还没做出来,过不了 evidence 判据。若你认为某条极有价值,写进 summary 提一句,不进 candidates。
4. 账本自身的记录纪律(「逐字留档用户原话」「每条必须标落点」「否决与放弃也要记」)有没有已进 dao;没有则它们是强候选(形态清晰:挂在"用户说了一句话"这个必经时刻上)`,
  },
}

const SOURCES = PICKED.map(key => ({
  key,
  model: SOURCE_DEFS[key].model,
  prompt: COMMON + SOURCE_DEFS[key].prompt,
}))

phase('收割')
const results = await pipeline(
  SOURCES,
  s => agent(s.prompt, Object.assign(
    { label: 'harvest:' + s.key, phase: '收割', schema: CANDIDATES },
    (s.model || DIG_MODEL) ? { model: s.model || DIG_MODEL } : {}
  )),
  async (r, s) => {
    if (!r) return null
    const all = r.candidates || []
    if (all.length === 0) {
      log('[' + s.key + '] 零候选(合格交付,source_health=' + ((r.source_health && r.source_health.yield) || '?') + '),跳过核验')
      return { source: s.key, harvest: r, verdict: null }
    }

    // 承重字段完整输入:candidates **分批**完整递交,不做 slice 截断(截断会让核验官
    // 看不到被切掉的部分而误裁,是已知缺陷来源——见条款库对抗验证官节)。
    const chunks = []
    for (let i = 0; i < all.length; i += CHUNK) chunks.push(all.slice(i, i + CHUNK))
    if (chunks.length > 1) log('[' + s.key + '] ' + all.length + ' 条候选分 ' + chunks.length + ' 批核验(不截断)')

    const vPrompt = (chunk, idx) => COMMON + `
【任务】对抗核验以下收割候选。**本次核验的头号靶子是「其实早就有了」**——本 workflow 最容易产出的噪音就是把条款库/dao.md 里已有的东西重新发明一遍。
逐条做三件事,缺一不算核验:
1. **独立判重**(不复用提交方的 dedup_checked,自己动手 Grep):在 \`${REPO}/${CLAUSE_FILE}\` 与 ${DAO_SCAN} 里用**至少两个不同的关键词**搜同类判据(同义词也要试——「基点对齐」和「merge-base」是同一件事)。命中同类 ⇒ \`is_new=false\`,\`pass=false\`,reason 里给出命中条款的原文首句与所在节。
2. **复核三判据**:①亲手打开 \`evidence\` 给的锚点确认它真实存在且支持该结论(文件+行要真能读到该内容;PR/commit 要真能 \`gh pr view\`/\`git show\` 到)——**锚点不存在或内容不支持 ⇒ pass=false**;②\`cross_project\` 有没有高报(去掉项目专有名词后还剩判据吗);③\`is_form\` 有没有高报——**这是最常被高报的一条**:问「不需要任何人想起来,它也会被执行吗?」答不出具体载体(模板/机检/PR 流程/权限/schema)就该是 false + trigger=无。
3. **复核归属层**:\`layer\` 是否与「换个项目还能用吗」一致。把只在本项目技术栈下成立的判成 dao 级是常见错误,反向(把通用判据塞进项目 rules)同样是错误。
另外:\`clause_text\` 必须**真的可直接粘贴**——检查元字段 \`[n= @ 触发:]\` 齐全、格式与条款库现有行一致、\`is_form=false\` 的同行带 \`[仅判据·无触发]\`。格式不合即 pass=false(这条很便宜但很重要:格式不对的候选落地时要人返工,等于没省用户的事)。
**禁**:不要因为一条候选"听起来很有道理"就放过判重与锚点复核。也不要为了显得严格而把成立的判成不成立——写清你的证据。
【待核验产出】source=${s.key}${chunks.length > 1 ? `(第 ${idx + 1}/${chunks.length} 批,本批 ${chunk.length} 条;其余批次由平行核验官处理,你只裁本批)` : ''}
summary: ${r.summary}
source_health: ${JSON.stringify(r.source_health)}
candidates(本批完整 JSON,未截断):
${JSON.stringify(chunk, null, 1)}`

    const parts = await Promise.all(chunks.map((c, i) =>
      agent(vPrompt(c, i), {
        label: 'verify:' + s.key + (chunks.length > 1 ? ':' + (i + 1) : ''),
        phase: '核验', schema: VERDICT, model: VERIFY_MODEL,
      })
    ))
    const ok = parts.filter(Boolean)
    const merged = ok.length === 0 ? null : {
      overall: ok.map((v, i) => (ok.length > 1 ? `[批${i + 1}] ` : '') + (v.overall || '')).join(' | '),
      verdicts: ok.flatMap(v => v.verdicts || []),
    }
    return { source: s.key, harvest: r, verdict: merged }
  }
)

const out = results.filter(Boolean)
const passed = out.reduce((acc, x) => acc + ((x.verdict && x.verdict.verdicts) || []).filter(v => v.pass).length, 0)
const total = out.reduce((acc, x) => acc + ((x.verdict && x.verdict.verdicts) || []).length, 0)
log('收割完成:' + out.map(x =>
  x.source + '(' + (x.harvest.candidates || []).length + '候选/' +
  ((x.harvest.source_health && x.harvest.source_health.yield) || '?') + ')'
).join(' · ') + ` — 核验通过 ${passed}/${total}`)
log('下一步(编排侧):通过的候选按 layer 分别粘贴进对应文件,粘完在收割标记文件里记本次收割点;' +
    '未通过的不要静默丢弃——把「判重命中了哪一条」记下来,那是「已有条款的 n= 该 +1」的输入。')
return out
