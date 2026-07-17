export const meta = {
  name: 'pillar-recon',
  description: '支柱大侦察：CLI agent 工作台价值维度全景扫描与奇思妙想挖掘',
  phases: [
    { title: '侦察', detail: '24 路多模态扫描：竞品痛点/头脑风暴透镜/仓库盘点', model: 'sonnet' },
    { title: '聚类', detail: '全量发现语义聚类为候选支柱', model: 'opus' },
    { title: '评审', detail: '每根候选支柱双镜评分（价值×差异化 / 可行×商业）', model: 'sonnet' },
    { title: '查漏', detail: '完整性批判官找未覆盖角度', model: 'opus' },
  ],
}

const CTX = `背景：mousse-cli 是 Tauri2+Rust+React 桌面工作台，托管 Claude Code/Codex 等 AI CLI agent（仓库 team-donk/mousse-cli 私有）。产品定位（用户定调）：类比「Codex Desktop 围绕 desktop 让用户爽」，mousse 围绕 CLI 让用户爽——目标用户就是 CLI agent 使用者，不是给小白降门槛。商业化项目，标准是「足够好用」。
已知四支柱假设（待检验，不许被它框死）：①记忆（session 不靠人肉记，已建成：多标签会话组+历史面板）②眼睛（VSCode 式改动可视，已建成：ScmView+DiffView+CodeMirror）③收件箱（便签/灵感暂存+用户或 AI 择时注入 CLI，半建成：composer 便签+LLM 拆解已落地，AI 择时注入未做）④生长性（DIY skills/手机派活电脑，仅骨架预留）。
你的使命：找出四支柱之外的新价值维度与奇思妙想，也可以推翻或重构已有支柱。`

const WEB = '检索工具：优先 WebSearch，深读页面用 WebFetch。每条发现必须带来源（URL 或「出处：xxx」的具体描述），无来源的条目会被评审直接丢弃。'
const LENS = '方法：第一性原理头脑风暴为主，可选用 WebSearch 找佐证。你是这个透镜的唯一专家，其他侦察兵看不到你的角度——挖深挖尽，不要泛泛。'
const REPO = '只读侦察本地仓库 D:/frank/mousse-cli（TODO.md / PROGRESS.md / CHANGELOG.md / docs/ / src-ui/ / crates/）。搜索一律用 Grep/Glob 工具，禁止 shell grep/find/rg。不修改任何文件。'

const FINDERS = [
  { key: 'cc-issues', brief: 'Claude Code 官方仓库（anthropics/claude-code）issues/discussions 的高频抱怨、呼声最高的 feature request——哪些是桌面工作台能接住的', mode: WEB },
  { key: 'codex-issues', brief: 'OpenAI Codex CLI（openai/codex）issues 的高频痛点与呼声——哪些是宿主工作台能接住的', mode: WEB },
  { key: 'coffee-issues', brief: 'Coffee-CLI（同类竞品，GUI 托管 CLI agent）的 issues + release notes——它的用户在骂什么、要什么、它最近在补什么（竞品 issues 是免费用户调研）', mode: WEB },
  { key: 'community', brief: 'Reddit（r/ClaudeAI 等）/ Hacker News / X 上关于 CLI coding agent 日常工作流的讨论——真实用户描述的不爽瞬间与土法自救（自写脚本/别名/笔记流程）', mode: WEB },
  { key: 'rival-clis', brief: 'Gemini CLI / OpenCode / aider / Crush 等其他 CLI agent 的 issues 与好评点——跨工具共性痛点（共性痛点=工作台最值得接的）', mode: WEB },
  { key: 'terminal-ai', brief: 'Warp / Wave Terminal / Ghostty 等现代终端产品的 AI/agent 功能布局——终端厂商认为用户要什么，哪些做得好哪些翻车', mode: WEB },
  { key: 'ide-vs-cli', brief: '开发者选 CLI agent 而弃 Cursor/Windsurf/Copilot 的理由，以及他们唯一怀念 IDE 的东西——mousse 的机会=CLI 的自由+IDE 的舒适', mode: WEB },
  { key: 'multi-instance', brief: '并行跑多个 agent 实例的实践（tmux 布局/git worktree/编排工具如 claude-squad）——多开党的痛点与自制方案', mode: WEB },
  { key: 'mobile-remote', brief: '手机/远程控制 coding agent 的需求与现有方案（SSH from phone / claude.ai/code web / 各类 remote agent app）——离开电脑后的焦虑与需求', mode: WEB },
  { key: 'cost-limits', brief: 'token 用量/额度/限流的可视化与管理（ccusage 类工具为何流行）——花钱的焦虑如何变成产品机会', mode: WEB },
  { key: 'lens-session', brief: '会话生命周期透镜：一个 session 的前（准备上下文/选目录/选模型）、中（监控/干预/续命）、后（复盘/归档/搜索/交接给下个 session）各环节还缺什么', mode: LENS },
  { key: 'lens-observe', brief: '可观测性透镜：CLI 里不可见的状态（上下文窗口余量/工具调用流水/subagent 树/todo 进度/改动时间线回放）哪些可视化后会「哇」', mode: LENS },
  { key: 'lens-input', brief: '输入摩擦透镜：CLI 难输入的东西（截图/长 prompt/多文件引用/语音/模板复用/历史 prompt 重放）如何被工作台消解', mode: LENS },
  { key: 'lens-trust', brief: '信任与安全透镜：权限审批疲劳/沙箱/密钥管理/危险命令拦截/一键回滚——「敢放手让 agent 跑」本身是不是一根支柱', mode: LENS },
  { key: 'lens-knowledge', brief: '知识资产透镜：CLAUDE.md/memory/skills/提示词库散落各处难管理——个人 AI 工作方式的资产化与可视化管理', mode: LENS },
  { key: 'lens-automation', brief: '自动化透镜：定时任务/文件监听触发/队列排程/CI 联动——agent 从「我在场才干活」到「我不在场也干活」', mode: LENS },
  { key: 'lens-delight', brief: '情绪价值透镜：超越功能的爽（干活时的战况仪式感/完成通知的成就感/多 agent 军团指挥感/主题与氛围）——什么让人愿意截图炫耀', mode: LENS },
  { key: 'lens-ecosystem', brief: '生态透镜：MCP server 管理/skills 市场/多账号多供应商切换/配置 profile——成为 AI CLI 生态的「应用商店+设置中心」', mode: LENS },
  { key: 'lens-team', brief: '协作透镜：session 分享/回放给同事、团队共享 skills 与提示词、agent 产出的团队 review 流——单机工作台的多人想象', mode: LENS },
  { key: 'lens-data', brief: 'local-first 数据资产透镜：所有会话/改动/决策都在本地 SQLite——全历史全文搜索/个人编程统计年报/知识提炼，数据主权即卖点', mode: LENS },
  { key: 'lens-onboarding', brief: 'time-to-wow 透镜：从装机到第一次「爽」要几步——检测已装 CLI/引导配置/示例任务/空状态设计，商业产品的第一分钟', mode: LENS },
  { key: 'lens-adjacent', brief: '相邻人群透镜：用 CLI agent 写作/做研究/做运营的非纯开发者——他们用得起 CLI 但更需要工作台，是不是被忽视的第二曲线', mode: LENS },
  { key: 'repo-inventory', brief: '盘点 mousse 已有能力与已承诺未做的（TODO.md 候选池/docs/kit 开工包/docs/design/orchestrator-vision.md 愿景）——找「已有地基但没长出楼」的价值点', mode: REPO },
  { key: 'dogfood-replay', brief: '复盘 PROGRESS.md 全部 dogfood 发现与 TODO.md 候选池——反复出现的主题=真实高频痛点，从中提炼支柱级信号', mode: REPO },
]

const FINDER_SCHEMA = {
  type: 'object', required: ['findings'],
  properties: { findings: { type: 'array', items: {
    type: 'object', required: ['idea', 'pain', 'source', 'novelty'],
    properties: {
      idea: { type: 'string', description: '一句话价值点，站在「桌面工作台能为 CLI 用户做什么」视角' },
      pain: { type: 'string', description: '解决 CLI 用户的什么不爽' },
      source: { type: 'string', description: '出处：URL / 讨论帖 / 仓库文件路径 / 第一性推理链' },
      novelty: { type: 'string', enum: ['已知支柱内', '新支柱候选', '奇思妙想'] },
    } } } },
}

const finderPrompt = (f) => `${CTX}

你是「${f.key}」路侦察兵，专攻角度：${f.brief}。
${f.mode}

产出 8-15 条发现。每条含 idea / pain / source / novelty 四字段。要求：
- 鼓励大胆的奇思妙想——宁可疯一点被后续评审砍掉，不要平庸重复已知四支柱
- 不写实现方案，只要价值点与痛点
- source 必须真实具体，编造出处会被对抗验证毙掉`

phase('侦察')
const found = await parallel(FINDERS.map((f) => () =>
  agent(finderPrompt(f), { label: '侦察:' + f.key, phase: '侦察', model: 'sonnet', schema: FINDER_SCHEMA })
))
const all = found.flatMap((r, i) =>
  r && r.findings ? r.findings.map((x) => Object.assign({}, x, { scout: FINDERS[i].key })) : []
)
log(`侦察归来：${found.filter(Boolean).length}/${FINDERS.length} 路成功，共 ${all.length} 条发现`)

const CLUSTER_SCHEMA = {
  type: 'object', required: ['pillars', 'unclustered', 'wild_ideas_top'],
  properties: {
    pillars: { type: 'array', items: {
      type: 'object', required: ['name', 'definition', 'maps_to', 'ideas'],
      properties: {
        name: { type: 'string', description: '支柱中文短名（2-6 字）' },
        definition: { type: 'string', description: '一句话定义：这根支柱让 CLI 用户在什么事上爽' },
        maps_to: { type: 'string', description: '映射：①/②/③/④ 之一、其扩展、或「新支柱」' },
        ideas: { type: 'array', items: { type: 'string' }, description: '去重后的成员价值点（保留最有代表性的表述+出处标注）' },
        wild: { type: 'array', items: { type: 'string' }, description: '本支柱下最疯最妙的想法' },
      } } },
    unclustered: { type: 'array', items: { type: 'string' } },
    wild_ideas_top: { type: 'array', items: { type: 'string' }, description: '全局最惊艳的 5-10 个奇思妙想（可跨支柱）' },
  },
}

phase('聚类')
const cluster = await agent(`${CTX}

下面是 ${all.length} 条来自 24 路盲侦察的发现（JSON）。任务：
1. 语义聚类为 6-14 根「候选支柱」——支柱=一类让 CLI 用户爽的价值维度，不是 feature 清单；同义合并、跨路去重
2. 每根标注与已知四支柱的映射关系（是①②③④本身/其扩展/全新）
3. 挑出全局最惊艳的奇思妙想 top 5-10（标准：听到会「咦这个有意思」，且竞品都没做）
4. 聚不进去的孤儿放 unclustered，不许硬塞

发现数据：
${JSON.stringify(all)}`, { label: '聚类合成', phase: '聚类', model: 'opus', schema: CLUSTER_SCHEMA })
log(`聚类完成：${cluster.pillars.length} 根候选支柱，${cluster.wild_ideas_top.length} 个全局妙想`)

const JUDGE_SCHEMA = {
  type: 'object', required: ['score_a', 'score_b', 'verdict', 'reasoning'],
  properties: {
    score_a: { type: 'integer', minimum: 1, maximum: 5 },
    score_b: { type: 'integer', minimum: 1, maximum: 5 },
    verdict: { type: 'string', enum: ['keep', 'merge', 'drop'] },
    reasoning: { type: 'string', description: '3-5 句：分数依据+最承重的证据或反例' },
  },
}

const pillarDesc = (p) => `支柱「${p.name}」：${p.definition}（映射：${p.maps_to}）\n成员价值点：\n${p.ideas.map((x) => '- ' + x).join('\n')}`

phase('评审')
const judged = await parallel(cluster.pillars.map((p) => () =>
  parallel([
    () => agent(`${CTX}

被审支柱：
${pillarDesc(p)}

你是「用户价值×差异化」评审官，对抗立场：
- score_a=用户价值：CLI agent 重度用户会为它尖叫还是耸肩？痛点频度与深度
- score_b=差异化：Coffee-CLI / Warp / IDE agent 是否已有？抄起来难不难？mousse 独有原语（hook 感知+PTY 驱动+local-first 数据）是否构成壁垒
- verdict：keep=独立成柱 / merge=并入其他支柱（reasoning 里说并给谁）/ drop=伪需求
默认怀疑，给分吝啬，5 分只留给「没有它我就不用这产品」级。`, { label: '评审A:' + p.name, phase: '评审', model: 'sonnet', schema: JUDGE_SCHEMA }),
    () => agent(`${CTX}

被审支柱：
${pillarDesc(p)}

你是「可行性×商业」评审官，对抗立场：
- score_a=可行性：在 mousse 现有架构（Tauri2+Rust headless core+React+hook 端点+SQLite local-first）上落地的顺滑度。可只读查证 D:/frank/mousse-cli（Grep/Glob 工具，禁 shell grep/find/rg，不修改文件）
- score_b=商业价值：对「商业化+足够好用」的贡献——付费意愿/传播力/留存力
- verdict：keep / merge / drop
默认怀疑，给分吝啬。技术上要重写骨架的、商业上叫好不叫座的，如实打低分。`, { label: '评审B:' + p.name, phase: '评审', model: 'sonnet', schema: JUDGE_SCHEMA }),
  ]).then((vs) => Object.assign({}, p, {
    value_diff: vs[0] || null,
    feas_comm: vs[1] || null,
    total: (vs[0] ? vs[0].score_a + vs[0].score_b : 0) + (vs[1] ? vs[1].score_a + vs[1].score_b : 0),
  }))
))
const pillars = judged.filter(Boolean).sort((a, b) => b.total - a.total)
log(`评审完成：${pillars.length} 根支柱已双镜打分`)

const CRITIC_SCHEMA = {
  type: 'object', required: ['gaps'],
  properties: { gaps: { type: 'array', items: {
    type: 'object', required: ['angle', 'why_matters', 'suggested_probe'],
    properties: {
      angle: { type: 'string', description: '被漏掉的角度/人群/场景' },
      why_matters: { type: 'string' },
      suggested_probe: { type: 'string', description: '如果要补侦察，派谁查什么' },
    } } } },
}

phase('查漏')
const critic = await agent(`${CTX}

本战役已跑的侦察角度：
${FINDERS.map((f) => f.key + '：' + f.brief).join('\n')}

聚类+评审后的支柱榜（按总分降序）：
${pillars.map((p) => `${p.name}（${p.total}/20，${p.maps_to}）：${p.definition}`).join('\n')}

你是完整性批判官。追问：还有什么角度、用户群、使用场景、时间维度（1 年后 agent 能力跃迁时）没被任何一路覆盖？评审是否有系统性盲区（例：全员都在想功能，没人想「少做什么」）？产出 3-8 条 gaps，每条给可执行的补侦察建议。`, { label: '查漏批判官', phase: '查漏', model: 'opus', schema: CRITIC_SCHEMA })

return {
  stats: { scouts_ok: found.filter(Boolean).length, scouts_total: FINDERS.length, raw_findings: all.length },
  pillars: pillars,
  wild_ideas_top: cluster.wild_ideas_top,
  unclustered: cluster.unclustered,
  gaps: critic.gaps,
}