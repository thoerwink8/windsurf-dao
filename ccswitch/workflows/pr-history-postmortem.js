export const meta = {
  name: 'pr-history-postmortem',
  description: 'PR 全史复盘(参数化):从任意仓库的 PR/提交原始数据里挖「执行缺陷」+ 验证条款有效性,五路镜头并行 → 逐路对抗核验',
  // ⚠ 本字段必须是**单个字符串字面量**——Workflow 工具校验 meta 为纯字面量，
  // 字符串 `+` 拼接是 BinaryExpression，会被整脚本拒载（2026-08-01 dao-harvest 实测同病）。
  whenToUse:
    '需要 args: {repoPath}(必填,不设默认——跨项目复用的资产不该内置某一个仓的路径)。可选 args: {ghRepo:"owner/name", prRange:{from,to}, lenses:[...], knownDefects:[...], clauseFile:"docs/rules/xxx.md", ledgerFiles:[...], goal:"...", model, verifyModel}。何时跑:①项目积累 100+ PR 且全部由 agent 产出,想知道「我们怎么干活出的问题」(不是产品 bug);②立了一批派单条款/流程规则,想验证它们入库后到底防住了什么;③长窗排程时想从历史里找选题;④**好实践收割的「量化聚合」半边**——另一半(单次叙事)由 `dao-harvest` 覆盖,见下。⚠ **它只是好实践的一半**:2026-07-27 首轮实测,本路的量化候选与 `dao-harvest` 的叙事候选**重合度为 0**(两个方向都零重合,互不相交不是子集)——「N 个 PR 都有某个毛病」只在把全史排成一列后才存在,单次叙事源结构上看不见它;反之「某官当场拒绝编造一个不可达的映射」不留统计痕迹,本路结构上看不见它。连带规律:**量化聚合天然产出形态类候选,单次叙事天然产出判断类**(能被计数就意味着有可机械识别的特征,而那特征本身就是现成的机检判据)。⇒ 收割场景下两个都要跑(同一 repoPath),只跑一个会系统性漏掉一整类;两份候选并到同一轮后**互相之间也要判重**,同一个病可能一边以「某次某官踩了」出现、另一边以「N 个 PR 都有」出现,那种情况合成一条且 n 取聚合那边的数字(真实复发次数下界)。改造自 2026-07-27 mousse-cli 单次专用版(硬编码仓路径/PR 上限/该仓当日已知缺陷清单),方法论骨架(五镜 + 对抗核验 + 「入库后归零必须排除没机会发生」)原样保留。',
  phases: [
    { title: '挖掘', detail: '五路并行:修复链/热点文件/欠账自述/停摆痕迹/条款有效性' },
    { title: '核验', detail: '逐路对抗核验,过度解读是头号靶子;findings 分批完整递交,不截断' },
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
    'pr-history-postmortem workflow requires args: {repoPath: "<仓库绝对路径>"}。' +
    '本 workflow 刻意不设仓库默认值——它是 dao 级跨项目资产,内置某一个仓的路径正是上一版' +
    '（单次专用版）不可复用的根因。'
  )
}

const ALL_LENSES = ['repair-chain', 'hotspot', 'debt-selfreport', 'stall-trace', 'clause-efficacy']
const PICKED = (ARGS && Array.isArray(ARGS.lenses) && ARGS.lenses.length) ? ARGS.lenses : ALL_LENSES
const unknown = PICKED.filter(k => !ALL_LENSES.includes(k))
if (unknown.length) {
  throw new Error(`未知镜头名:${unknown.join(', ')}；合法值:${ALL_LENSES.join(' / ')}`)
}

const DIG_MODEL = (ARGS && ARGS.model) || undefined          // 缺省由 harness 决定档位
const VERIFY_MODEL = (ARGS && ARGS.verifyModel) || 'sonnet'
const CHUNK = 8                                              // 单个核验官一次最多接几条 finding

// ---- 可选参数 → prompt 片段（缺省时给出通用表述，不留 mousse-cli 特有字样）----
const ghRepoLine = (ARGS && ARGS.ghRepo)
  ? `GitHub 仓 ${ARGS.ghRepo}。`
  : `GitHub 仓名未由调用方给出——先在 ${REPO} 跑 \`gh repo view --json nameWithOwner\` 自取,取不到就说明取不到并降级为纯 git 分析。`

const prRangeLine = (ARGS && ARGS.prRange && (ARGS.prRange.from || ARGS.prRange.to))
  ? `本次复盘范围:PR #${ARGS.prRange.from ?? 1} 起至 #${ARGS.prRange.to ?? '最新'}。`
  : `本次复盘范围:全史(#1 起至今)——先拉一次轻量元数据看实际有多少个,再决定深挖哪些。`

const goalLine = (ARGS && ARGS.goal)
  ? ARGS.goal
  : '「从历史中找到我们干活方式上的缺陷」。注意是**执行缺陷**(流程/协作/验证怎么出的问题),不是产品缺陷(软件本身的 bug)。'

const knownDefects = (ARGS && Array.isArray(ARGS.knownDefects) && ARGS.knownDefects.length)
  ? `【已知背景(不必重新发现)】调用方声明的已知执行缺陷:${ARGS.knownDefects.join('、')}。` +
    `**你的价值在于找这些之外的、或给这些补上 PR 层面的量化证据。**`
  : `【已知背景】调用方**未**提供已知缺陷清单——本轮不预设任何结论,凡你判为模式的都要自证 2-3 例,` +
    `不得假设指挥官已经知道。`

const LEDGERS = (ARGS && Array.isArray(ARGS.ledgerFiles) && ARGS.ledgerFiles.length)
  ? ARGS.ledgerFiles
  : ['CHANGELOG.md', 'PROGRESS.md', 'TODO.md']

const CLAUSE_FILE = (ARGS && ARGS.clauseFile) || null

const COMMON = `【身份与红线】你是 workflow subagent,回答对象是编排器,不是用户——禁止调用 AskUserQuestion,直接返回结构化结果。只读:不写不改任何文件、不 commit、不动配置。
【工具】搜索用内置 Grep/Glob,读文件用 Read。**本任务允许用 Bash 跑 \`gh\` CLI 与 \`git log\` 取 PR/提交数据**(这是内置工具做不到的),但仍禁止用 shell 跑 grep/find/cat/tail 做文本搜索或一次性读大文件。
【仓库】${REPO}。${ghRepoLine}${prRangeLine}
【取数建议(省 token)】先拿轻量元数据再按需深挖:
  \`gh pr list --state all --limit 300 --json number,title,createdAt,mergedAt,state,author\`
  \`gh pr view <n> --json body,files,comments\`(只对筛出的可疑 PR 用)
  \`git -C ${REPO} log --oneline --all\` / \`git -C ${REPO} log --format=... -- <path>\`
**不要逐个拉全部 PR 的 body**——那会烧掉整个预算且信息密度极低。先用元数据筛,再深读。
【目标(调用方原话)】${goalLine}
【禁】过度解读——单个案例不构成模式,至少 2-3 例同型才算。找不到模式就诚实说「该维度无显著模式」,**零发现是合格交付**。禁笃定措辞(「已全覆盖」「无遗漏」类),近似手段如实标注为近似。
${knownDefects}`

const FINDINGS = {
  type: 'object', required: ['summary', 'findings'],
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array', items: {
        type: 'object',
        required: ['pattern', 'instances', 'evidence', 'root_cause', 'proposal', 'confidence'],
        properties: {
          pattern: { type: 'string', description: '模式名 + 一句话机制' },
          instances: { type: 'array', items: { type: 'string' }, description: '具体 PR 编号/提交 hash 列表,至少 2-3 例' },
          evidence: { type: 'string', description: '可复核的数据:次数、时间差、文件名、body 原文片段' },
          root_cause: { type: 'string' },
          proposal: { type: 'string', description: '可执行改法:改哪条条款/加什么闸/换什么形态;无解就说无解' },
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
        type: 'object', required: ['pattern', 'holds', 'note'],
        properties: { pattern: { type: 'string' }, holds: { type: 'boolean' }, note: { type: 'string' } },
      },
    },
  },
}

const LENS_DEFS = {
  'repair-chain': {
    prompt: `
【镜头】修复链分析——**谁在修谁**。
方法:扫全部 PR 标题与 commit message,找出「修复前一个 PR 引入的问题」型 PR(标题含 fix/revert/订正/回归/补/漏,或 body 引用了另一个 PR 号)。建立「PR A 引入 → PR B 修复」的配对。
要回答:
1. **修复链有多长**:有没有「B 修 A,C 又修 B」的三连及以上?给 PR 层面的量化
2. **哪类改动最容易引入需要后续修复的问题**:按被修 PR 的类型分布(按本仓实际模块划分,先看目录结构再归类,不要套用别的项目的分类)
3. **修复间隔**:从引入到被发现平均多久?有没有潜伏很久才被发现的(潜伏期长 = 当时的验证没覆盖到)
4. **同一处被修 N 次**:找出被反复修的具体文件/函数,那里大概率有设计问题而非实现问题
每条 finding 必须列出具体 PR 编号。`,
  },
  'hotspot': {
    model: 'sonnet',
    prompt: `
【镜头】改动热点分析——**哪些文件被反复改**。
方法:\`git -C ${REPO} log --format='%H' --all\` + \`git log --name-only\` 统计文件被 PR 触及的次数。**排除账本类文件**(本仓已知账本:${LEDGERS.join(' / ')};若目录里还有别的必然高频的流水账文件,自行判断并在 summary 里说明你排除了哪些、为什么)。
要回答:
1. **Top 15 高频改动的产品代码文件**,各被多少个 PR 触及
2. 其中哪些是「**功能持续扩张**」(正常)vs「**同一处反复返工**」(设计问题)——判据:看每次改动的 commit message 是加功能还是修 bug/订正
3. **文件体量与改动频率的关系**:有没有「大文件 + 高频改动」的双高危区(那是重构信号)
4. 有没有文件的改动**总是伴随另一个文件**(隐式耦合,说明抽象没做对)
5. 若本仓有体量/复杂度类检查脚本(先 Glob \`scripts/**\` 与 CI 配置看有没有),对照其红线/观察线,热点文件里有几个已在逼线;没有这类脚本就明说「本仓无体量守卫,该问不适用」`,
  },
  'debt-selfreport': {
    prompt: `
【镜头】欠账自述扫描——**PR body 里如实写了欠账,但没人接住**。
背景机制(不是本仓的具体事故,是这一类的通用形态):实现官在 PR body 的「未做到/已知缺口」段如实写下欠账,而终审只核了验证汇总表就合并,PR 关联的 issue 被 auto-close 标 COMPLETED,欠账当场失去落脚点。**这类事一旦发生通常不是孤例**。
方法:拉 PR 的 body(预算有限时优先近半数),找含「未做到/已知缺口/欠账/未覆盖/挂账/待补/降级交付/未验证/无法验证」等词的段落。
要回答:
1. **有多少 PR 自述了欠账**,各欠什么
2. 这些欠账**后来被接住了吗**——查待办账本 / issue 列表 / 后续 PR 里有没有对应条目。给出「接住率」
3. 没被接住的欠账,现在还成立吗(有些可能已被后续改动顺带解决——**必须实测复现,不要照着历史清单当真**)
4. **自述欠账的位置**:在 body 哪个部分(有独立小节 vs 埋在正文),位置与被接住率是否相关
5. 提案:怎么让欠账在合并瞬间必然有落脚点。**先查本仓已有什么闸**(PR 模板 / issue 模板 / CI 检查),你的提案应与既有机制互补而非重复`,
  },
  'stall-trace': {
    model: 'sonnet',
    prompt: `
【镜头】停摆与节律痕迹——**从时间戳里读出执行断点**。
方法:用 PR 的 createdAt/mergedAt 与 commit 时间序列,画出活动密度。
要回答:
1. **异常长的空档**:相邻 PR 合并间隔显著超出常态的时段,各多长;若调用方给了已知停摆型缺陷,看能否在 PR 时间线上找到对应的空洞
2. **PR 从创建到合并的时长分布**:有没有长期挂着不合的(那是终审积压)
3. **批量合并的簇**:短时间内合并多个 PR 的时刻,是否伴随后续的修复 PR(赶工质量代价)
4. **深夜/连续长时段作业与缺陷率的关系**:把 PR 按合并时刻分段,看后续被修复的比例有无差异(样本可能不足,不足就说不足,**不要为了给结论而降低样本门槛**)
5. 每条结论必须给具体时间戳与 PR 编号,禁凭印象`,
  },
  'clause-efficacy': {
    prompt: `
【镜头】**条款/规则有效性验证(本轮最高价值一路)**——不是找新缺陷,是验证「已有的规则到底防住了什么」。
${CLAUSE_FILE
  ? `本仓的条款库在 \`${REPO}/${CLAUSE_FILE}\`。`
  : `调用方未指定条款库路径——先 Glob 找本仓的规则/条款文件(常见位置:\`.claude/rules/**\`、\`docs/rules/**\`、\`CLAUDE.md\`、\`CONTRIBUTING.md\`)。**若本仓根本没有成文规则库,直接判「该镜头不适用」并说明,不要硬凑。**`}
方法:
1. 读规则全文,挑出**能对应到 PR 层面可观测事件**的条款(如「实现官止步 gh pr create」「验证唯一入口」「基点对齐」「版本号多处同步」「PR 必附截图」等),忽略纯过程性、PR 里看不见的条款
2. 对每条:确定它的**入库时刻**(\`git -C ${REPO} log -S<条款关键词> -- <规则文件>\`;注意规则文件可能被移动过路径,\`--follow\` 或对旧路径各查一次,否则会把早期条目算成「新立」)
3. 统计**入库前 vs 入库后**,该类问题在 PR 里的出现频率
要回答:
1. **哪些条款有实证效果**(入库后同类问题归零或显著下降)——给数字
2. **哪些条款入库后同类问题仍在发生**(条款失效)——给具体复发 PR
3. **哪些条款从未有过对应样本**(无法判定有效性,可能是过度立法)
4. 对失效条款:判断它是不是要求「在无标记时刻发起自由裁量动作」——若是,它大概率提供的只是判据而非触发点,给出形态化改法(挂进模板/挂进机检/挂进 PR 或 commit 流程)
【诚实要求(本镜头最容易犯的错)】样本量小的不要硬下结论。「入库后归零」也可能是因为那类任务本身没再出现过,**必须区分「防住了」与「没机会发生」**——做法:先数入库后该类任务的**发生机会数**,机会数为零的一律判「无法判定」而非「有效」。`,
  },
}

const LENSES = PICKED.map(key => ({
  key,
  model: LENS_DEFS[key].model,
  prompt: COMMON + LENS_DEFS[key].prompt,
}))

phase('挖掘')
const results = await pipeline(
  LENSES,
  l => agent(l.prompt, Object.assign(
    { label: 'dig:' + l.key, phase: '挖掘', schema: FINDINGS },
    (l.model || DIG_MODEL) ? { model: l.model || DIG_MODEL } : {}
  )),
  async (r, l) => {
    if (!r) return null
    const all = r.findings || []
    if (all.length === 0) {
      log('[' + l.key + '] 零发现(合格交付),跳过核验')
      return { lens: l.key, recon: r, verdict: null }
    }

    // 承重字段完整输入:findings **分批**完整递交,不做 slice 截断。
    // 单次专用版曾用 `all.slice(0, 8)` + 一行 log 交代——但那行 log 核验官看不见,
    // 于是被截掉的部分既没被核验、也没在核验产出里留下痕迹(核验官看不到被截断
    // 部分会误裁,是已知缺陷来源)。本版改为按 CHUNK 切块并行核验后合并。
    const chunks = []
    for (let i = 0; i < all.length; i += CHUNK) chunks.push(all.slice(i, i + CHUNK))
    if (chunks.length > 1) log('[' + l.key + '] ' + all.length + ' 条 findings 分 ' + chunks.length + ' 批核验(不截断)')

    const vPrompt = (chunk, idx) => COMMON + `
【任务】对抗核验以下复盘结论。**过度解读是本次核验的头号靶子**:逐条问「这几个案例真的构成模式吗,还是巧合/幸存者偏差?」——2 例以下的、或案例之间机制不同的,判 holds=false。
同时亲手复核至少 3 条 instances 里的 PR 编号确实存在且内容支持该结论(用 \`gh pr view\`)。数字类结论至少抽验 2 条重算。
**比较基线必须先验证它自己是活的**:凡结论形如「改后比改前好」,先证明「改前那一版真的在工作」——已经失效的东西当然「零问题」,拿它当基线会把真实代价误判成退化。
特别注意 clause-efficacy 一路:**「入库后归零」必须排除「没机会发生」**,未排除的判 holds=false。
【待核验产出】lens=${l.key}${chunks.length > 1 ? `(第 ${idx + 1}/${chunks.length} 批,本批 ${chunk.length} 条;其余批次由平行核验官处理,你只裁本批)` : ''}
summary: ${r.summary}
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
    return { lens: l.key, recon: r, verdict: merged }
  }
)

const out = results.filter(Boolean)
const held = out.reduce((acc, x) => acc + ((x.verdict && x.verdict.verdicts) || []).filter(v => v.holds).length, 0)
const total = out.reduce((acc, x) => acc + ((x.verdict && x.verdict.verdicts) || []).length, 0)
log('完成:' + out.map(x => x.lens + '(' + (x.recon.findings || []).length + '条)').join(' · ') +
    ` — 核验通过 ${held}/${total}`)
return out
