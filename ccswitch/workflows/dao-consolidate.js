export const meta = {
  name: 'dao-consolidate',
  description: 'dreaming 式离线整编(参数化):对条款库/dao 场域/收割台账做「合并重复 · 标记过期 · 消解冲突」三镜扫描 → 对抗核验(默认倾向留) → 产出**建议清单/diff**交人拍板。绝不直接改任何条款文件。',
  // ⚠ 本字段必须是**单个字符串字面量**——Workflow 工具校验 meta 为纯字面量，
  // 字符串 `+` 拼接是 BinaryExpression，会被整脚本拒载（2026-08-01 实测报
  // "meta must be a pure literal: non-literal node type in meta: BinaryExpression"，
  // 出处见同目录 dao-harvest.js meta 头注）。改这一段时不要为了排版把它拆成多段相加。
  whenToUse:
    '需要 args: {repoPath}(必填,不设默认——跨项目资产不该内置某一个仓的路径)。可选 args: {lenses:["duplicate","stale","conflict"], clauseFile, daoFile, daoRulesDir, harvestLogFile, extraCorpus:[...], goal, model, verifyModel}。⚠ **语料面横跨两个仓,repoPath 填的是「持有条款库的项目仓」**:clauseFile / harvestLogFile 是相对 repoPath 的**项目侧**路径,daoFile / daoRulesDir 是 **dao 仓**的绝对路径。拿 dao 仓自己当 repoPath 时项目侧那两面必然不可达(2026-08-01 首跑实测,三镜独立撞到);**只整编 dao 侧语料是合法用法**——把 clauseFile 与 harvestLogFile 显式传 null 把那两面摘掉即可(摘掉是声明,不可达是故障,报告里长得不一样)。何时跑:①规则集明显只增不减、有人开始抱怨「条款库没人通读得完」时②刚完成一批收割、新条款入库后(收割是加法,本 workflow 是它的减法对偶)③退役观察线打印出一批候选、需要有人逐条判「这条还有用吗」时④两条条款在同一次派单里给出了打架的指令。解的问题:**立法有天然触发器(刚踩坑、正在写复盘),退役没有**——「这条还有用吗」要在无标记时刻主动问,正是实测携带率 9-24% 的那一类动作,于是规则集单向膨胀直到无人通读。⚠ **它是好实践收割 `dao-harvest` 的对偶而不是替代**:那个只有「抽模式」半边(结构上 append-only,产出永远是新增条款),本 workflow 是「合并重复/标记过期/重组」那半边。两个都跑才构成一进一出的闭环。⚠ **两条铁护栏写死在 agent prompt 里,不可由 args 关掉**:①产出是**建议清单**不是覆写——任何一条落地都要人 approve,workflow 全程只读 ②**改一条必须引具体 case**(AutoManual case-conditioned:不许凭空抽象「这两条看着像」,要指出哪一次实际使用中它们给出了相同/矛盾指令)。形态出处:Anthropic Dreaming(2026-05-06,异步重组→团队 approve/reject/modify→部署)+ AutoManual(NeurIPS 2024,结构化规则 CRUD + case-conditioned 防幻觉),调研正文见 windsurf-dao docs/research/rules-arch-survey-oss-20260801.md §2.3/§3.1。',
  phases: [
    { title: '扫描', detail: '三镜并行:重复对(同一 case 给出相同指令)/过期候选(引用已死·基线过时·被覆盖·正文搬空)/冲突对(同一 case 给出矛盾指令)' },
    { title: '核验', detail: '逐条设法反驳:合并会不会丢承重差异、过期判定是不是误读、冲突是不是射程本就不重叠。反驳不掉才保留;拿不准一律判「留」' },
  ],
}

// ── 这个 workflow 为什么长这样（读者省时段）────────────────────────────────────
// 1. **产出是建议不是改写**：条款库是 always-on 面，误删一条的代价远高于多留一条，而模型
//    对「这两条看着像」的直觉正是最不可靠的那一类判断。故全程只读，产出「改前原文/改后稿/
//    理由/出处 case」四件套，落地由人一条一条 approve。
// 2. **没有数值相似度阈值**（与派单契约里「语义重叠 >阈值」的措辞的显式偏离，理由写在这里）：
//    harness 里没有可调用的 embedding/相似度算子，模型自报的「相似度 0.82」是**编出来的数字**
//    （dao 条款库通用节「禁笃定措辞」正面命中）。改用 **case-conditioned 判据**：两条是不是
//    重复，不看字面像不像，看**在同一个具体 case 上它们是不是让人做同一件事**。这个判据的
//    好处是可复核（case 有锚点，读者能自己去看），坏处是它**漏掉「还没有人在同一个 case 上
//    同时用过这两条」的重复对**——两个方向都写清楚，不宣称覆盖全。
// 3. **默认倾向「留」**：核验阶段的判定规则是「反驳不掉才保留建议」，「拿不准」一律归到留。
//    这是刻意的不对称——漏一条该退役的，代价是规则集多一行；错删一条还在生效的，代价是一个
//    没人知道的行为缺口。（同源判据：dao.md 反·归「规则集只增不减是结构必然」那条讲的是
//    退役要有触发器，**不是**说退役越多越好。）
// 4. **corpus_census 是下限自陈，不是独立分母**：扫描官自己报「条款总数 N、我逐条读了 M」，
//    这个数与它的发现来自同一次阅读 ⇒ 它瞎掉时两个数会一起塌（dao.md 反·归「守卫里『我是不是
//    瞎了』那一半绝不能复用被守对象的解析逻辑」讲的正是这个）。这里**没有**独立普查函数，
//    故 census 只能当「它自称看了多少」读，不能当覆盖率证据。要真分母得由编排侧另跑一次
//    机械计数（如条款库仓自己的 check-clauses-structure.ps1），本 workflow 不假装有。

// `args` 可能以调用方原始 JSON 字符串形式到达,也可能已是解析好的对象,视运行时而定——
// 两种形态都归一化处理。不是合法 JSON 的字符串原样落回,交给下方必填校验去报错。
const ARGS = typeof args === 'string'
  ? (() => { try { return JSON.parse(args) } catch (e) { return args } })()
  : args

const REPO = ARGS && ARGS.repoPath
if (!REPO) {
  throw new Error(
    'dao-consolidate workflow requires args: {repoPath: "<仓库绝对路径>"}。' +
    '刻意不设仓库默认值——它是 dao 级跨项目资产,内置某一个仓的路径正是 workflow 不可复用的根因' +
    '(同 dao-harvest / pr-history-postmortem 的取舍)。'
  )
}

const ALL_LENSES = ['duplicate', 'stale', 'conflict']
const PICKED = (ARGS && Array.isArray(ARGS.lenses) && ARGS.lenses.length) ? ARGS.lenses : ALL_LENSES
const unknownLens = PICKED.filter(k => !ALL_LENSES.includes(k))
if (unknownLens.length) {
  throw new Error(`未知镜头:${unknownLens.join(', ')}；合法值:${ALL_LENSES.join(' / ')}`)
}

// 档位**显式传**,不靠继承(2026-08-01 dao.md 帅节实证:workflow 的 agent() 不传 model 时不继承
// 主会话档,掉到 harness 默认 opus-4.8)。两档都可由 args 覆盖;写死确切 ID 而非别名 `opus`,
// 因为别名的解析归属不在本脚本控制范围内。⚠ 模型 ID 随代际滚动,这两行是**已知的维护点**。
const DIG_MODEL = (ARGS && ARGS.model) || 'claude-opus-5'
// 核验档**刻意不降 sonnet**(与 dao-harvest 的取舍相反,理由写在这里):本 workflow 的产出是
// **删/合**建议,误报代价高于漏报,而核验是唯一的拦截面;收割那边误报的代价只是多一条候选。
const VERIFY_MODEL = (ARGS && ARGS.verifyModel) || 'claude-opus-5'
const CHUNK = 5   // 单个核验官一次最多接几条发现(逐条要亲手复核锚点,批不宜大)

// ⚠ **语料面横跨两个仓,这是本 workflow 的参数结构里最容易配错的一处**(2026-08-01 首次干跑
// 三镜**独立**撞到同一个问题,一致判为「疑似 repoPath 配错」):`clauseFile` / `harvestLogFile`
// 是**项目侧**相对路径(相对 `repoPath`),而 `daoFile` / `daoRulesDir` 是**dao 仓**的绝对路径。
// ⇒ `repoPath` 应填**持有条款库的那个项目仓**;拿 dao 仓自己当 repoPath 时,项目侧那两面必然
// 不可达。**只想整编 dao 侧语料是合法用法**,此时把 `clauseFile` / `harvestLogFile` 显式传
// `null` 把那两面摘掉——摘掉是**声明**,不可达是**故障**,两者在报告里长得不一样。
// 用 `'key' in ARGS` 而非 `||`,正是为了让显式 `null` 与「没传」可区分。
const has = (k) => !!ARGS && typeof ARGS === 'object' && k in ARGS
const CLAUSE_FILE = has('clauseFile') ? ARGS.clauseFile : 'docs/rules/dispatch-clauses.md'
const DAO_FILE = has('daoFile') ? ARGS.daoFile : 'D:/frank/windsurf-dao/ccswitch/dao.md'
// dao 常驻场域的正文**不止 dao.md 一个文件**:长窗自主排程等整节已迁到 ccswitch/rules/ 下,
// dao.md 那一段只剩一行存根。只扫 dao.md 会让那些正文落在扫描面之外 ⇒ 整编官看不到它们,
// 而输出看起来完全正常(扫描面静默塌陷)。用目录而非枚举文件,以后再迁出别的节不用回来改这里。
const DAO_RULES_DIR = has('daoRulesDir') ? ARGS.daoRulesDir : 'D:/frank/windsurf-dao/ccswitch/rules/'
const HARVEST_LOG = has('harvestLogFile') ? ARGS.harvestLogFile : 'docs/ops/harvest-log.md'
const EXTRA_CORPUS = (ARGS && Array.isArray(ARGS.extraCorpus) && ARGS.extraCorpus.length)
  ? ARGS.extraCorpus
  : []

// `faces` 是**渲染出的 bullet**,`faceCount` 是**语料源个数**——两者不等:dao.md 与 rules/ 目录
// 是两个源、但合写成一个 bullet(它们同属 dao 常驻场域,分开写会让读者以为要分两轮扫)。
// 头部那个「共 N 面」必须报**源数**,否则会与下面「已显式摘掉」那份逐源清单对不上
// (首版就是拿 bullet 数当面数,摘掉两个源后头部报「共 1 面」而摘掉清单列了 2 条,自相矛盾)。
const faceCount = [CLAUSE_FILE, DAO_FILE, DAO_RULES_DIR, HARVEST_LOG].filter(Boolean).length
const faces = []
if (CLAUSE_FILE) {
  faces.push(`- **条款库**:\`${REPO}/${CLAUSE_FILE}\` —— 顶层条款行的形态是行首 \`- \` 且行尾带 \`[n= @ 触发:]\` 元字段。`)
}
if (DAO_FILE || DAO_RULES_DIR) {
  faces.push(`- **dao 常驻场域**:${DAO_FILE ? `\`${DAO_FILE}\`(正文)` : '(调用方已摘掉 dao.md 正文)'}${(DAO_FILE && DAO_RULES_DIR) ? ' 与 ' : ''}${DAO_RULES_DIR ? `\`${DAO_RULES_DIR}\` 下全部 .md(由 dao.md 存根指出去的细则正文,如长窗排程/派单/写守卫)` : ''}。${(DAO_FILE && DAO_RULES_DIR) ? '**两处都要扫**,只扫 dao.md 会漏掉整段。' : ''}`)
}
if (HARVEST_LOG) {
  faces.push(`- **收割台账**:\`${REPO}/${HARVEST_LOG}\` —— 里面的**待批候选**(尚未落地的条款提案)同样进扫描面:一条候选与既有条款重复,和两条既有条款重复,是同一个病,而且拦在落地前更便宜。`)
}
if (EXTRA_CORPUS.length) {
  faces.push(`- **调用方追加的语料面**(同等对待):${EXTRA_CORPUS.map(p => '`' + p + '`').join(' · ')}`)
}
if (!faces.length) {
  throw new Error(
    'dao-consolidate: 四个语料面被全部摘掉(clauseFile / daoFile / daoRulesDir / harvestLogFile 都是 null 或空),' +
    '没有任何东西可扫。至少留一面——摘面是为了「只整编 dao 侧」或「只整编项目侧」,不是为了跑一次空转。'
  )
}
const omitted = [
  CLAUSE_FILE ? null : '条款库', DAO_FILE ? null : 'dao.md 正文',
  DAO_RULES_DIR ? null : 'dao rules 目录', HARVEST_LOG ? null : '收割台账',
].filter(Boolean)
const omittedLine = omitted.length
  ? `\n\n📌 **调用方已显式摘掉这些面**:${omitted.join(' · ')}。**这是声明不是故障**——不要去找它们、不要在 \`unreachable\` 里报它们,也不要因此判本轮覆盖不全;如实按剩下的面作业即可。`
  : ''

// 元字段语义的真相源在**条款库**里。那一面被摘掉时,这句话不能照渲染——首跑实测它会渲染成
// 一个字面量 `<repo>/null` 的路径,核验官 Glob 后当场指出「这一格对提交方和我都不可达」。
// 这是「留一个指向空气的指针比没有指针更糟」的最小实例:读者会以为有个地方能查,于是不再自己求证。
const META_SEMANTICS_SRC = CLAUSE_FILE
  ? `以 \`${REPO}/${CLAUSE_FILE}\` 的「条款元字段」节为准——**动笔前先读那一节**。`
  : '本轮**没有纳入条款库那一面**(调用方显式摘掉了),故没有可查的真相源:**照你在本轮语料里读到的既有用法办,不要凭空发明取值**;拿不准就在 rationale 里写明「元字段取值未经核对,因本轮无条款库可查」。'

const CORPUS = `
【本轮的语料面(共 ${faceCount + EXTRA_CORPUS.length} 面,逐面先确认可达)】
${faces.join('\n')}${omittedLine}

🔴 **逐面先确认可达再动手**:用 Read/Glob 确认文件真的存在。**不存在就在 \`corpus_census.unreachable\` 里写明哪一面不可达、你探了什么路径**,然后只对可达的面作业。三条硬性处置:
- **不要为了凑满几面去猜一个相近的文件**。
- 🔴 **不得跨仓替换语料**(2026-08-01 首跑实测的分歧点,写死免得下次又各判各的):若你发现同名同相对路径的文件住在**另一个仓**,那是**给编排侧的线索**——写进 \`unreachable\` 说清你在哪儿看见了它,**但不要扫它**。理由不是保守:你报的 \`file\` 字段会被核验官拿着**本轮声明的仓**去复核,扫了别的仓就会整批落空;而且写入面稳定性只对声明仓库作过保证。正确处置是让编排侧改参数重跑。
- 「文件不存在」与「文件存在但已退役」是两回事:后者(头部有「已退役 / 历史存档 / 不要再往本文件挂新问题」类字样)当**历史快照**读,可以从中取 case 当证据,但**不得**把它里面的条目当现役条款去提议合并/退役。

🔴 **一律 Read 盘上文件,禁用你上下文里已注入的那份 dao.md 快照**(2026-08-01 首跑实测:注入快照与盘上文件当时不一致——盘上已把整节存根化,快照还是搬迁前的全文;那一轮有一条冲突候选就是这么产生的假阳性,靠该官坚持读盘才撤下来)。**always-on 快照按 compaction 刷新,天然滞后**,而本 workflow 的全部产出都以「盘上现在长什么样」为准。

【大文件读法(条款库与 dao.md 都是数万 token 级,禁全量硬读)】
1. 先用 Grep 拿**全域清单**:\`output_mode: content\`、\`-n: true\`,pattern 取顶层条款行的形态(如 \`^- \\*\\*\` 或 \`\\[n=\`),先看总数与分布,再决定读哪几段。
2. 再用 Read 的 \`offset\`/\`limit\` 分段读你真正要判的那几段;单行极长时用 Grep 的 \`-o\` + **有界小窗口**(\`.{0,30}(关键词).{0,150}\`,\`head_limit: 20~30\`)。窗口放大到 \`.{0,80}…{0,260}\` 会大量返回「Omitted long matching line」而看不到内容。
3. **你读了多少就报多少**:\`corpus_census\` 要如实填「条款总数 / 我逐条读过的条数」。读不完是允许的,**谎报读完不允许**——本 workflow 没有独立分母能拆穿你,所以这一格全靠你自陈。`

const COMMON = `【身份与红线】你是 workflow subagent,回答对象是编排器,不是用户——禁止调用 AskUserQuestion,直接返回结构化结果。
🔴 **本 workflow 全程只读,这是它的定义性约束不是客套话**:不写不改任何文件(**尤其不许改条款库、dao.md、rules/、台账**)、不 commit、不动配置。你的产出是**给人看的建议清单**,任何一条要不要落地由用户拍板。**发现一条明显该删的条款,也只准写进建议清单,不准动手删。**
【工具】搜索用内置 Grep/Glob,读文件用 Read(大文件必须带 offset/limit 分段)。**允许用 Bash 跑 \`git log\`/\`git show\`/\`gh\` CLI/\`ls\` 类目录探测**(内置工具做不到,而条款的出处 case 常常只能从 git 历史里核实),但仍禁止用 shell 跑 grep/find/cat/tail/Select-String 做文本搜索或一次性读大文件。
【仓库】${REPO}。
${CORPUS}

【两条铁护栏(违反任一即该条发现作废,核验官会逐条查)】
① **产出是建议不是改写**:每条发现必须凑齐四件套——**改前原文**(逐字复制,不许转述)/**改后稿**(可直接粘贴的完整替换文本;判为「只标记不改写」时写明 \`(不改写,仅标记)\` 并说清标记内容)/**理由**/**出处 case**。缺任一件的发现不许提交。
② **改一条必须引具体 case(case-conditioned)**:禁止凭「这两条看着像 / 这条听起来过时了」下判断。每条发现的 \`evidence\` 必须指向**一次实际使用**并给可复核锚点——PR 编号 / commit hash / 文件+行 / 台账条目编号(如 \`H2-4\`) / 条款正文里明写的实证。**答不出「哪一次实际用到它们时出了这个问题」的,一律不进 findings**,改写进 \`not_submitted\` 并说明为什么撤下来。
   \`not_submitted\` 不是失败记录,它是本 workflow 唯一能让读者区分「真的没有」与「有但我不敢报」的地方——**空着比写满更可疑**。

【判据取值与措辞(照条款库的既有约定,别自己发明)】
- 条款元字段 \`[n=<复发次数> @<首次入库月日> 触发:<触发点>]\` 的语义${META_SEMANTICS_SRC}改后稿必须保留/正确处理这些字段。
- \`触发:无\` **不等于「这条没价值」**。条款库明写:判据层在事后核验与争议裁定里独立有用,\`无\` 的含义是「不该指望这一条自己改变行为」。**因此「它 \`触发:无\`」永远不构成退役理由**,把它当理由是本 workflow 最容易犯的误报,核验官会专门查这一条。
- **观察区条目不是条款**(条款库末节「观察区(判断类候选 · 复发即升格)」):它们的处置是「升格」或「久未复发」,**不是退役**。不许对观察区条目提退役建议;它们只在与正式条款**重复**时才进 \`duplicate\` 镜。

【禁】
- 禁笃定措辞(「已全覆盖」「无遗漏」「此后任何 X 都被 Y」):本 workflow 的判据全是近似手段,如实标注为近似并写明两个方向都构造得出反例。
- 禁自造数字:没有相似度算子就不许写「相似度 0.8」;没数过就不许写占比。**数出来的数字要说明你怎么数的**。
- 禁凑数:一面上真的没有可整编的,就在 \`corpus_census\` 里说明你扫了什么、为什么判空。**零发现是合格交付**——「这个条款库目前没有可合并的重复对」与「找到 8 对」同等有用,前者还更便宜。
- 禁越界:不许顺手提「这条写得不好该重写」类风格意见。本轮只做三件事——合并重复 / 标记过期 / 消解冲突。别的观察写进 \`summary\` 一句话,不进 findings。`

// ── schema 片件 ───────────────────────────────────────────────────────────────
const clauseRef = (which) => ({
  type: 'object', required: ['file', 'locator', 'before_text'],
  properties: {
    file: { type: 'string', description: `${which}所在文件的路径(相对仓库根或绝对路径,与你实际读的那个一致)` },
    locator: { type: 'string', description: '定位信息:行号 + 一个能唯一 Grep 到该行的短语。行号会随改动漂移,故两者都要给' },
    before_text: { type: 'string', description: '**改前原文**,逐字复制该条款整行(不许转述、不许省略元字段)。超长条款可截到前 400 字并显式标注「…(后略)」' },
    section: { type: 'string', description: '它所在的节(如「通用节」「实现官节」「dao.md 帅节」),用于判断归属层是否一致' },
  },
})

const CENSUS = {
  type: 'object', required: ['clause_total', 'clauses_read', 'faces_scanned', 'unreachable', 'how_counted'],
  properties: {
    clause_total: { type: 'string', description: '你在扫描面上数到的顶层条款总数(给数字;数不全就写「≥N,未数全」)' },
    clauses_read: { type: 'string', description: '其中你**逐条读过正文**的条数。读不完是允许的,谎报不允许' },
    faces_scanned: { type: 'string', description: '逐面列出:条款库 / dao.md / rules 目录 / 台账 / 追加语料,各扫了什么、多少条目' },
    unreachable: { type: 'string', description: '哪一面不可达或已退役,你探了哪些路径。全部可达就写「无」' },
    how_counted: { type: 'string', description: '你怎么数出 clause_total 的(哪条 Grep pattern / 哪个命令)。这一格让读者能自己复核分母' },
  },
}

const scanSchema = (findingItem) => ({
  type: 'object', required: ['summary', 'corpus_census', 'findings', 'not_submitted'],
  properties: {
    summary: { type: 'string', description: '一段话:你扫了什么、总体判断、以及你认为这一镜在本仓的产量等级与理由' },
    corpus_census: CENSUS,
    findings: { type: 'array', items: findingItem },
    not_submitted: {
      type: 'array',
      description: '疑似但**没有**提交的条目:缺 case、核实不了、或自己反驳掉了。空数组要在 summary 里说明是「真的一条疑似都没有」还是「疑似的都提交了」',
      items: {
        type: 'object', required: ['what', 'why_not'],
        properties: {
          what: { type: 'string', description: '疑似什么(点名涉及的条款)' },
          why_not: { type: 'string', description: '为什么撤下来:缺具体 case / 核实后不成立 / 射程其实不重叠 / 其他' },
        },
      },
    },
  },
})

const MERGE_ITEM = {
  type: 'object',
  required: ['id', 'clause_a', 'clause_b', 'shared_case', 'evidence', 'divergence_check', 'meta_merge_note', 'proposed_text', 'rationale', 'verdict', 'confidence'],
  properties: {
    id: { type: 'string', description: '本镜内唯一编号,形如 M1/M2/M3(从 1 连续编,核验官靠它把裁定对回来)' },
    clause_a: clauseRef('条款 A'),
    clause_b: clauseRef('条款 B'),
    shared_case: { type: 'string', description: '**同一个具体 case**:说清在那一次里 A 会让人做什么、B 会让人做什么、为什么那是同一件事。禁止写「都是讲 X 的」这种类目级描述' },
    evidence: { type: 'string', description: '**出处 case 的可复核锚点**:PR 编号 / commit hash / 文件+行 / 台账条目编号 / 条款正文里明写的实证。给不出锚点的不许提交' },
    divergence_check: { type: 'string', description: '**反向自问,逐项作答**:两条各自有没有对方没有的承重内容——①射程边界 ②例外/豁免分支 ③触发点档位(机检档/槽位档/无) ④n 与基线数字 ⑤出处实证 ⑥所在节与官种归属。任一项不同,要么在改后稿里保住它,要么改判为「不该合」' },
    meta_merge_note: { type: 'string', description: '元字段合并的处理与**副作用自陈**:合并后 n 怎么取(取下界还是相加,说明理由)、@ 取哪一个、触发: 怎么定。⚠ 必须点明一个已知的错误激励——**两条 n=1 合成 n=2 会把它们一起移出「候选退役区只扫 n=1」的审查面**(条款库既有实证),你的合并是否踩了它、可接受与否' },
    proposed_text: { type: 'string', description: '**改后稿**:可直接粘贴替换的完整条款行(含元字段)。它必须同时覆盖 A 与 B 的承重内容' },
    rationale: { type: 'string', description: '**理由**:为什么合并比留两条好。收益要具体(少一次重复计费/消一处措辞漂移/两处判据同源),不写「更简洁」这类空话' },
    verdict: { type: 'string', enum: ['建议合并', '建议保留两条但交叉引用', '建议保留两条(仅记录疑似)'], description: '默认倾向保留;只有承重差异都能在改后稿里保住时才建议合并' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
}

const RETIRE_ITEM = {
  type: 'object',
  required: ['id', 'clause', 'kind', 'verification_done', 'evidence', 'audit_three_questions', 'proposed_text', 'rationale', 'verdict', 'confidence'],
  properties: {
    id: { type: 'string', description: '本镜内唯一编号,形如 R1/R2(从 1 连续编)' },
    clause: clauseRef('该条款'),
    kind: {
      type: 'string',
      enum: ['dead-reference', 'mechanism-gone', 'stale-baseline', 'superseded', 'hollow-pointer'],
      description: 'dead-reference=它引用的脚本/文件/命令/节已不存在 · mechanism-gone=它防的那个机制已不存在(工具卸载/流程退役) · stale-baseline=基线数字或口径已被后续实测推翻 · superseded=已被后来的条款完整覆盖 · hollow-pointer=正文已迁走只剩一句指针,而指针目标读者本来就会读到(**这一类是按年龄捞的退役观察线结构上永远看不见的,是本镜最独有的产出**)',
    },
    verification_done: { type: 'string', description: '**你亲手做了什么来确认它真过期**:跑了哪条 Glob/Read/git 命令、结果是什么。dead-reference 类**必须**有一次「确认该路径不存在」的实跑;只凭印象说「那个脚本好像删了」的一律不许提交' },
    evidence: { type: 'string', description: '**出处 case 的可复核锚点**:哪次实际使用中它已经不起作用/指向了空气。找不到实际使用 case 的,退而给出它所引用对象消失的那个 commit/PR,并在 rationale 里说明「无使用 case,仅有引用面证据」' },
    audit_three_questions: {
      type: 'object', required: ['q1_why_exists', 'q2_still_possible', 'q3_would_deleting_change_anything'],
      description: '规则生命周期三问(外部借来的判据,出处 dev.to「The Lifecycle of a Rule」;**该来源的两问/三问门槛未在本仓验证过**,故只作结构化提问用,不作自动判定)',
      properties: {
        q1_why_exists: { type: 'string', description: '还答得出它为什么存在吗(有出处/实证吗)' },
        q2_still_possible: { type: 'string', description: '它防的那个模式在当前架构下还可能发生吗' },
        q3_would_deleting_change_anything: { type: 'string', description: '过去一段时间里删掉它,会改变任何可观察到的东西吗。**这一问通常答不出**(没有条款消融测量)——答不出就写「答不出:本仓无消融测量」,**不许编一个答案**' },
      },
    },
    proposed_text: { type: 'string', description: '**改后稿**:建议退役就写「(建议整条移除)」并附移除后需要补的交叉引用;建议改写为指针/收窄射程就给可直接粘贴的完整新行;只标记不改写就写「(不改写,仅标记)」+ 标记内容' },
    rationale: { type: 'string', description: '**理由**,并显式回答「留着它的代价是什么」——只占一行文本的条款,留着的代价很低,这一格答不出实质代价时应倾向保留' },
    verdict: { type: 'string', enum: ['建议退役', '建议改写为指针', '建议收窄射程', '建议先回填元字段再议', '保留'], description: '默认 `保留`;证据不足、三问答不满、或代价说不清的一律归到保留或「先回填元字段再议」' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
}

const CONFLICT_ITEM = {
  type: 'object',
  required: ['id', 'clause_a', 'clause_b', 'conflict_case', 'case_kind', 'evidence', 'scope_check', 'proposed_text', 'rationale', 'verdict', 'confidence'],
  properties: {
    id: { type: 'string', description: '本镜内唯一编号,形如 C1/C2(从 1 连续编)' },
    clause_a: clauseRef('条款 A'),
    clause_b: clauseRef('条款 B'),
    conflict_case: { type: 'string', description: '**同一个具体时刻**:在那一刻 A 要求做 X、B 要求做 ¬X(或不相容的 Y),照哪一条做都会违反另一条。要写清那个时刻是什么' },
    case_kind: { type: 'string', enum: ['真实发生过', '构造'], description: '`真实发生过`=有 PR/commit/台账锚点证明有人撞上过;`构造`=结构性冲突但尚无实例——此时必须在 rationale 里说明它**为什么必然会到达**,且 confidence 上限 medium' },
    evidence: { type: 'string', description: '**出处 case 的可复核锚点**。case_kind=构造 时,这里给的是两条条款各自射程的锚点(文件+行),并注明「无实例」' },
    scope_check: { type: 'string', description: '**反向自问**:这两条是不是射程本就不重叠、只是读起来像在打架(不同官种节 / 不同触发条件 / 一条自带豁免分支)?逐项排除后仍冲突才提交。**「读起来矛盾」与「同一时刻真的二选一」是两回事**' },
    proposed_text: { type: 'string', description: '**改后稿**:消解方案。优先给**射程边界或优先级**的一句话(哪条在什么条件下优先),而不是删掉一条——两条都是被实证立起来的,冲突通常说明缺一个仲裁条件而不是有一条错了' },
    rationale: { type: 'string', description: '**理由**:说清消解方案为什么不会把两条各自要防的伤害放掉' },
    verdict: { type: 'string', enum: ['建议加仲裁条件', '建议收窄其中一条的射程', '建议合并为一条带分支的条款', '判为不冲突(仅记录)'], description: '默认倾向最小改动;拿不准写「判为不冲突(仅记录)」' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
}

const VERDICT = {
  type: 'object', required: ['overall', 'verdicts'],
  properties: {
    overall: { type: 'string', description: '一段话:本批整体判断 + 你独立复核时发现的系统性问题(若有)' },
    verdicts: {
      type: 'array', items: {
        type: 'object', required: ['id', 'anchors_checked', 'refutation_tried', 'what_would_be_lost', 'upheld', 'final_verdict', 'reason'],
        properties: {
          id: { type: 'string', description: '与待核验发现的 id 逐字一致(M1/R2/C3…),否则编排侧对不回去' },
          anchors_checked: { type: 'string', description: '你**亲手**打开/跑过的锚点与结果:文件+行真读到了吗、commit 真 show 得出来吗、那个「不存在的路径」你自己 Glob 过吗。不复用提交方的说法' },
          refutation_tried: { type: 'string', description: '你**试了哪几种反驳**且各自结果如何。一条都没试就判 upheld=true 视为未核验' },
          what_would_be_lost: { type: 'string', description: '按这条建议做了之后,**会丢什么**:射程边界/例外分支/元字段/出处实证/某个官种的可读性。答「什么都不丢」要说明你逐项对过' },
          upheld: { type: 'boolean', description: '**反驳不掉才 true**。拿不准、证据不足、无法核实一律 false(默认倾向留)' },
          final_verdict: {
            type: 'string',
            enum: ['采纳', '采纳但需修改改后稿', '驳回-误报', '驳回-证据不足', '降级为仅记录观察'],
            description: '`采纳但需修改改后稿` 时必须在 reason 里给出你要改的那一处',
          },
          reason: { type: 'string', description: '附独立证据锚点(文件+行 / 命令+真退出码)。禁「看起来没问题」类模糊措辞。**驳回也要给证据**——为显得严格而否掉成立的发现,与放过误报同样有害' },
        },
      },
    },
  },
}

// ── 三镜 prompt ───────────────────────────────────────────────────────────────
const LENS_DEFS = {
  'duplicate': {
    bucket: 'merge_pairs',
    item: MERGE_ITEM,
    prompt: `
【本镜】**重复对** —— 找出「两条条款在同一个具体 case 上给出**相同**指令」的对。

🔴 **判据不是字面相似度,是 case 上的同指令性**。本 workflow **刻意不设数值相似度阈值**:harness 里没有可调用的相似度算子,模型自报的「重叠 0.8」是编出来的数字(直接命中条款库「禁笃定措辞」)。故判据改为:
  **想象一个具体时刻,如果照 A 做和照 B 做会得到同一个动作,它们才是重复。**
两条条款讲同一个主题、用同一批名词、甚至出处是同一次事故,**都不足以判重复**——真正要问的是「有没有哪个人在某个时刻,同时被这两条要求做同一件事」。
**这个判据的已知代价照直说**:它漏掉「还没有人在同一个 case 上同时用过这两条」的重复对(结构性漏报)。两个方向都写清,不宣称覆盖全。

【怎么找(次序照做,省 token)】
1. 先 Grep 拿全域条款清单(行号 + 行首 60 字),**通读标题级信息**,把主题相近的先归堆——这一步只是**捞取入口**,不是判据。
2. 对每一堆里的候选对,回到正文逐条读**完整两条**(条款常有长正文与射程边界,只读首句必误判)。
3. 逐对做 \`divergence_check\` 六问(射程/例外/触发档/n 与基线/出处/所在节)。**只要有一项是对方没有的承重内容,默认判「不该合」**,除非你的改后稿能一字不落地保住它。
4. 找 \`shared_case\`:去 git log / PR / 台账 / 条款自己的出处标注里找**真的有人同时受这两条约束**的那一次。找不到就写进 \`not_submitted\`。

【本镜最容易犯的三种误报(核验官会专门查)】
- **同族≠重复**:两条讲同一个病的**不同成因**或**同一风险的两端**(如「开工前基点对齐」与「交付前基点复检」),看着极像,实为互补——合掉一条会留下一个缺口。条款库里已有这类**刻意成对**的条款。
- **上位/下位≠重复**:一条给判据、另一条给该判据在某个具体载体上的落点(dao.md 给跨项目判据、项目条款库给本仓执行侧一行),这是**分层不是重复**,合并会破坏归属层。
- **射程宽窄≠重复**:一条覆盖 A∪B,另一条只覆盖 A 但给了 A 特有的细则。合并成宽的那条会丢掉细则。

【也要报的一类(便宜且高价值)】
台账里**尚未落地的待批候选**与既有条款重复 —— 拦在落地前比落地后再合并便宜得多。这类的 \`clause_b\` 指向台账条目(file 写台账路径,locator 写条目编号如 \`H2-4\`),\`verdict\` 用「建议保留两条(仅记录疑似)」并在 rationale 里写明「建议是**别落地那条候选**,不是改既有条款」。`,
  },

  'stale': {
    bucket: 'retire_candidates',
    item: RETIRE_ITEM,
    prompt: `
【本镜】**过期候选** —— 找出「已经不该再留在扫描面上」的条款。五类,逐类给判据:

1. **dead-reference**:它引用的脚本 / 文件 / 命令 / 节 / issue 已不存在。**必须亲手 Glob/Read 确认那个路径真的不在**(\`verification_done\` 要写你跑的那一条与结果)。⚠ 高频假阳性:文件**改名或迁移**了 ⇒ 那是「指针该改指新址」不是「条款该退役」,\`verdict\` 应为「建议改写为指针」。
2. **mechanism-gone**:它防的那个机制本身没了(工具被卸载、流程退役、平台改了行为)。要给出「机制没了」的锚点,而不是「我觉得现在不用了」。
3. **stale-baseline**:\`[基线:…]\` 或正文里的数字/口径已被后续实测推翻。⚠ 这一类的正确处置**通常不是退役而是订正**——数字过时不代表判据过时。
4. **superseded**:被后来的条款**完整覆盖**(后者的射程包含前者且细则不丢)。要逐条比对射程,别把「相关」当「覆盖」。
5. **hollow-pointer**:**正文已被搬走、只剩一句指针**,而指针目标是读者本来就会读到的地方(如 always-on 文件)。**这一类是本镜最独有的产出**——按年龄捞的退役观察线对它结构上失明(该退的形态与年龄无关),而它只有人工通读才捞得出来。找到即高价值。

【默认倾向「留」,以下四条是硬性的不许(违反即该条作废)】
- ❌ **不许以「\`触发:无\`」为退役理由**。条款库明写:\`无\` 的含义是「不该指望这一条自己改变行为」,判据层在事后核验与争议裁定里独立有用。这是本镜的头号误报形态。
- ❌ **不许对观察区条目提退役**。它们是候选不是条款,处置是「升格」或「久未复发」。
- ❌ **不许以「n=1 / n=?」为退役理由**。\`n=?\` 的语义是「未标次数,**不等于零次**」,直接判它退役与直接排除它是同一个错的两面(都在替未知下结论);对 \`n=?\` 的正确处置是 \`建议先回填元字段再议\`。
- ❌ **不许以「太长了 / 写得啰嗦」为退役理由**。篇幅不是判据,本轮不做风格意见。

【三问怎么用】
每条填 \`audit_three_questions\`。这三问借自外部实践(dev.to「The Lifecycle of a Rule」的月度审计三问),**它的「失败 2 条即候选、3 条全败即删」门槛未在本仓验证过**,故这里**只用它的提问结构,不用它的自动判定**——最终 \`verdict\` 仍由你逐条说理。第三问(删掉它会改变任何可观察的东西吗)在没有条款消融测量的仓里**通常答不出**:答不出就写「答不出:本仓无消融测量」,**编一个答案比留空更糟**。

【留着的代价要说得出来】
\`rationale\` 必须回答「留着它的代价是什么」。一条条款占的是一行文本 + always-on 面上的一点注意力预算——**这个代价很低**,所以说不出实质代价(误导人 / 与别条打架 / 指向空气让人以为有兜底)的,一律归 \`保留\`。**漏一条该退的,代价是规则集多一行;错删一条还在生效的,代价是一个没人知道的行为缺口。** 这个不对称是本镜的立场。`,
  },

  'conflict': {
    bucket: 'conflicts',
    item: CONFLICT_ITEM,
    prompt: `
【本镜】**冲突对** —— 找出「两条条款在同一个具体时刻给出**矛盾**指令」的对:照 A 做就违反 B,照 B 做就违反 A。

【最高价值的三个找法(按优先级)】
1. **跨文件冲突**:项目条款库 vs dao 常驻场域 vs rules/ 细则。三处由不同批次、不同人在不同时间写下,**没有任何机制保证它们互相一致**,这里的冲突最可能真实存在且最难被发现(读者通常只读到其中一处)。
2. **同一节里的先后层积**:同一节的条款是逐次追加的,后加的常常在收窄或推翻前面某一条的一部分,而**前面那条没被同批改**。找「后来的条款说『其实不必 X』,而前面某条要求『必须 X』」这种。
3. **条款 vs 它自己的例外分支**:一条给绝对禁令、另一条给该禁令的豁免条件,而两处对豁免边界的描述不一致。

【硬要求】
- \`scope_check\` **必须先排除「射程本就不重叠」**:不同官种节 / 不同触发条件 / 一条自带豁免分支 —— 逐项排除后仍二选一才叫冲突。**「读起来矛盾」与「同一时刻真的二选一」是两回事**,后者才提交。
- \`case_kind\` 如实标。**优先找真实发生过的**(有人撞上过、有 PR/台账痕迹);找不到实例的结构性冲突可以提交,但标 \`构造\` 且 confidence 上限 medium,并在 rationale 里说清**它为什么必然会到达**——一个永远不会同时触发两条的「冲突」不值得改任何东西。
- **消解方案优先给仲裁条件,不是删一条**:两条通常都是被实证立起来的,冲突多半说明缺一个「什么条件下哪条优先」的仲裁句,而不是有一条错了。删一条会把它要防的伤害放掉。

【本镜的已知弱点,写进你的 summary】
真冲突在成熟条款库里是**稀有**的,而模型倾向于把「侧重不同」读成「互相矛盾」。**零发现是本镜非常可能且完全合格的结果**——若你一条都没找到,就明说「零冲突」并列出你**重点排查过**的那几组(让读者知道你扫了哪里),不要为了有产出而把互补条款说成冲突。`,
  },
}

// ── 编排 ─────────────────────────────────────────────────────────────────────
const LENSES = PICKED.map(key => ({
  key,
  bucket: LENS_DEFS[key].bucket,
  item: LENS_DEFS[key].item,
  prompt: COMMON + LENS_DEFS[key].prompt,
}))

const verifyHead = {
  'duplicate': '合并会不会丢承重差异(射程/例外/触发档/元字段/出处/归属层)——**默认它会丢**,要提交方证明不丢,而不是你证明它丢',
  'stale': '过期判定是不是误读——**四种最常见的误读**:①拿 `触发:无` 当退役理由 ②拿 `n=1`/`n=?` 当退役理由 ③文件只是改名/迁移被读成「已消失」 ④基线过时被读成判据过时(那该订正不该退役)',
  'conflict': '这两条是不是**射程本就不重叠**、只是读起来像在打架;以及 `case_kind: 构造` 的那些,它描述的时刻是不是真的会到达',
}

phase('扫描')
const results = await pipeline(
  LENSES,
  l => agent(l.prompt, {
    label: 'consolidate:' + l.key,
    phase: '扫描',
    model: DIG_MODEL,
    schema: scanSchema(l.item),
  }),
  async (r, l) => {
    if (!r) return null
    const all = r.findings || []
    if (all.length === 0) {
      log('[' + l.key + '] 零发现(合格交付,未提交 ' + ((r.not_submitted || []).length) + ' 条疑似),跳过核验')
      return { lens: l.key, bucket: l.bucket, scan: r, verdict: null }
    }

    // 承重字段完整输入:findings **分批**完整递交,不做 slice 截断——核验官看不到被切掉的
    // 部分就会误裁,是已知缺陷来源(条款库对抗验证官节「承重字段完整输入」)。
    const chunks = []
    for (let i = 0; i < all.length; i += CHUNK) chunks.push(all.slice(i, i + CHUNK))
    if (chunks.length > 1) log('[' + l.key + '] ' + all.length + ' 条发现分 ' + chunks.length + ' 批核验(不截断)')

    const vPrompt = (chunk, idx) => COMMON + `
【任务】**对抗核验**以下整编建议。你是这批建议落地前的唯一拦截面——它们要改的是 always-on 的规则语料,**误报的代价高于漏报**。
🔴 **判定规则:反驳不掉才 upheld=true。拿不准、核不实、证据不足,一律 upheld=false(默认倾向「留」)。**
本批的头号靶子:${verifyHead[l.key]}。

逐条做四件事,缺一不算核验:
1. **亲手复核锚点**(不复用提交方的说法):\`before_text\` 真的能在它说的文件那一行读到吗(逐字比对,尤其元字段)?\`evidence\` 给的 PR/commit/行号真的存在且支持那个结论吗?说「路径不存在」的,你自己 Glob 一次。**锚点对不上 ⇒ 直接 upheld=false**。
2. **设法反驳**:至少试两种不同的反驳角度并写进 \`refutation_tried\`。一条都没试就判 upheld=true 视为未核验。
3. **算「会丢什么」**:按这条建议做完之后丢掉的东西,逐项列(射程边界/例外分支/触发点档位/n 与基线/出处实证/官种可读性)。答「什么都不丢」必须说明你逐项对过。
4. **复核改后稿可直接用**:格式与既有条款行一致、元字段 \`[n= @ 触发:]\` 齐全且取值合法、不丢承重内容。格式不对 ⇒ \`采纳但需修改改后稿\` 并在 reason 里点明改哪一处。

【两个方向的禁】
- 不要因为一条建议"听起来有道理"就放过锚点复核。
- **也不要为了显得严格而把成立的发现否掉**——驳回同样要给证据锚点。这两个方向的错代价相当:放过误报会删掉还在生效的规则,滥杀会让整编机制失去信任而被弃用。

【待核验产出】lens=${l.key} —— **本路扫描共 ${all.length} 条发现 + ${(r.not_submitted || []).length} 条自撤(not_submitted)**,你手上这批 ${chunk.length} 条${chunks.length > 1 ? `(第 ${idx + 1}/${chunks.length} 批;其余批次由平行核验官处理,你只裁本批)` : '(未分批,即全部)'}。
📌 **这三个数是给你分辨「分批」与「静默截断」用的**:\`summary\` 描述的是**整路**产出,它提到的发现可能不在你这批里——那**不是**输入被截断。真要判截断,看的是「本批 ${chunk.length} 条」与下面 JSON 里实际几条对不对得上。自撤的那 ${(r.not_submitted || []).length} 条**不归你裁**(它们没进建议清单),给你数字只是让你知道扫描官撤了多少。
summary: ${r.summary}
corpus_census: ${JSON.stringify(r.corpus_census)}
findings(本批完整 JSON,未截断):
${JSON.stringify(chunk, null, 1)}`

    const parts = await Promise.all(chunks.map((c, i) =>
      agent(vPrompt(c, i), {
        label: 'verify:' + l.key + (chunks.length > 1 ? ':' + (i + 1) : ''),
        phase: '核验', schema: VERDICT, model: VERIFY_MODEL,
      })
    ))
    const ok = parts.filter(Boolean)
    const merged = ok.length === 0 ? null : {
      overall: ok.map((v, i) => (ok.length > 1 ? `[批${i + 1}] ` : '') + (v.overall || '')).join(' | '),
      verdicts: ok.flatMap(v => v.verdicts || []),
    }
    return { lens: l.key, bucket: l.bucket, scan: r, verdict: merged }
  }
)

// 合成:每条发现挂上它自己的裁定。对不上 id 的**不静默丢弃**,标 verified=null 并计数——
// 「没被核验」与「核验通过」在下游长得一样,正是本体系反复踩的那个病。
const out = { merge_pairs: [], retire_candidates: [], conflicts: [], corpus_health: [], not_submitted: [] }
let upheldCount = 0, totalCount = 0, unverified = 0

for (const x of results.filter(Boolean)) {
  const vs = (x.verdict && x.verdict.verdicts) || []
  const byId = {}
  for (const v of vs) if (v && v.id) byId[v.id] = v
  for (const f of (x.scan.findings || [])) {
    const v = byId[f.id] || null
    if (!v) unverified++
    else { totalCount++; if (v.upheld) upheldCount++ }
    out[x.bucket].push(Object.assign({}, f, { lens: x.lens, verified: v }))
  }
  for (const n of (x.scan.not_submitted || [])) out.not_submitted.push(Object.assign({ lens: x.lens }, n))
  out.corpus_health.push({
    lens: x.lens,
    summary: x.scan.summary,
    census: x.scan.corpus_census,
    verifier_overall: (x.verdict && x.verdict.overall) || '(零发现,未派核验官)',
  })
}

log('整编扫描完成:' + results.filter(Boolean).map(x =>
  x.lens + '(' + ((x.scan.findings || []).length) + '条建议/' + ((x.scan.not_submitted || []).length) + '条未提交)'
).join(' · ') + ` — 核验保留 ${upheldCount}/${totalCount}` + (unverified ? `,⚠ ${unverified} 条未拿到裁定(已标 verified=null,不要当作通过)` : ''))
log('🔴 本 workflow 未改动任何文件。产出是**建议清单**:每条带「改前原文/改后稿/理由/出处 case」+ 核验裁定,' +
    '逐条呈用户 approve/reject/modify 后才由编排侧粘贴落地;被驳回的不要静默丢弃——' +
    '「哪一条被反驳掉、理由是什么」是下一轮整编的输入,也是防止同一个误报被反复重新发现的唯一记录。')
return out
