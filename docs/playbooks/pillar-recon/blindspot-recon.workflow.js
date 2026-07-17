export const meta = {
  name: 'blindspot-recon',
  description: '三路补盲侦察：克制/护城河蒸发/变现——为终版支柱图补上三面镜子',
  phases: [
    { title: '补盲侦察', detail: '3 路：lens-restraint / lens-moat / lens-monetize', model: 'sonnet' },
  ],
}

const CTX = `背景：mousse-cli（Tauri2+Rust+React 桌面工作台，托管 Claude Code/Codex 等 AI CLI agent）。定位：围绕 CLI 让用户爽，目标用户=CLI agent 重度使用者；商业化项目，标准「足够好用」。
刚完成 52-agent 支柱大侦察，13 根候选支柱（总分/20）：
1.开箱与环境保真15（第一分钟信任+环境漂移哨兵）2.成本罗盘14（跨厂商 token/费用聚合+燃烧率）3.时间机器14（对话+代码联动倒带）4.舰队指挥台13（N-agent 态势总览+分诊）5.Agent内窥镜13（上下文预算/推理回放/真相vs自述）6.输入工学12（截图直挂/@文件/粘贴折叠）7.知识资产12（CLAUDE.md/skills/prompt 资产化管理）8.生态装备12（MCP/skills 跨工具统一配置）9.信任护栏11（宿主级审批/危险拦截）10.本地数据主权11（全历史语义搜索+可携带）11.自主与远程10（定时/无人值守+手机召回）12.情绪与身份9（战绩仪式感）13.垂直深化8（非开发者，已被评审 drop）。
详细定义可 Read D:/frank/mousse-cli/docs/research/pillar-recon-20260717.md（帅合成判读）。
你是查漏官点名的补盲侦察兵——上一轮的结构性盲区，由你这一路补上。检索工具：WebSearch/WebFetch，每条结论必须带来源（URL 或具体出处），无来源即废。`

const RESTRAINT_SCHEMA = {
  type: 'object', required: ['dont_do_list', 'cli_beats_mousse', 'pillar_bloat'],
  properties: {
    dont_do_list: { type: 'array', items: { type: 'object', required: ['item', 'why', 'evidence'], properties: { item: { type: 'string' }, why: { type: 'string' }, evidence: { type: 'string' } } } },
    cli_beats_mousse: { type: 'array', items: { type: 'object', required: ['scenario', 'why'], properties: { scenario: { type: 'string' }, why: { type: 'string' } } } },
    pillar_bloat: { type: 'array', items: { type: 'object', required: ['pillar', 'resident_cost', 'note'], properties: { pillar: { type: 'string' }, resident_cost: { type: 'string', enum: ['零常驻', '轻', '中', '重'] }, note: { type: 'string' } } } },
  },
}

const MOAT_SCHEMA = {
  type: 'object', required: ['precedents', 'pillar_defense'],
  properties: {
    precedents: { type: 'array', items: { type: 'object', required: ['case', 'what_died', 'lesson'], properties: { case: { type: 'string' }, what_died: { type: 'string' }, lesson: { type: 'string' } } } },
    pillar_defense: { type: 'array', items: { type: 'object', required: ['pillar', 'rating', 'reasoning'], properties: { pillar: { type: 'string' }, rating: { type: 'string', enum: ['vendor-killable', 'mixed', 'structurally-defensible'] }, reasoning: { type: 'string' } } } },
  },
}

const MONETIZE_SCHEMA = {
  type: 'object', required: ['pricing_landscape', 'backlash_cases', 'paywall_map', 'invite_gate_guidance'],
  properties: {
    pricing_landscape: { type: 'array', items: { type: 'object', required: ['product', 'model', 'notes'], properties: { product: { type: 'string' }, model: { type: 'string' }, notes: { type: 'string' } } } },
    backlash_cases: { type: 'array', items: { type: 'object', required: ['case', 'trigger', 'lesson'], properties: { case: { type: 'string' }, trigger: { type: 'string' }, lesson: { type: 'string' } } } },
    paywall_map: { type: 'array', items: { type: 'object', required: ['pillar', 'tier', 'reasoning'], properties: { pillar: { type: 'string' }, tier: { type: 'string', enum: ['free-attract', 'paid-convert', 'gate-toxic'] }, reasoning: { type: 'string' } } } },
    invite_gate_guidance: { type: 'array', items: { type: 'string' } },
  },
}

phase('补盲侦察')
const [restraint, moat, monetize] = await parallel([
  () => agent(`${CTX}

你是 lens-restraint（克制透镜）。上一轮 24 路侦察全员做加法，你专做减法。
① 扒 Warp 的登录/遥测/内存反噬（HN + r/commandline 出走 Ghostty/alacritty 的具体理由与原话）
② Coffee-CLI 及同类 GUI 壳 issues 里「太重/太慢/我只想要终端」类抱怨
③ 极简终端（Ghostty/kitty/alacritty）拥趸的价值观取样——他们逃离的到底是什么
产出三件套：
a) dont_do_list：mousse 明确「不做」的反功能负面清单（每条带 why+evidence）
b) cli_beats_mousse：一张诚实的「何时直接用 CLI 胜过开 mousse」对照表（这是产品自信不是遮丑）
c) pillar_bloat：给 13 根支柱逐根标注常驻开销代价（零常驻/轻/中/重）+ 一句臃肿风险注记`, { label: '补盲:克制', phase: '补盲侦察', model: 'sonnet', schema: RESTRAINT_SCHEMA }),
  () => agent(`${CTX}

你是 lens-moat（护城河蒸发测试）。上一轮没人问「这条痛点厂商下个版本会不会自己补掉」。
① 梳理 Anthropic（Claude Code）/OpenAI（Codex CLI）近 6 个月 changelog 与公开 roadmap，找「官方原生化后杀死/边缘化第三方工具」的实例（如官方 usage 视图 vs ccusage、官方 /rewind vs 手搓 checkpoint、官方 subagent 可视化等），每例写清死了谁、怎么死的
② 对 13 根支柱逐根打防御性评级：vendor-killable（厂商一个 release 内可追平）/ mixed（部分可追平）/ structurally-defensible（跨厂商聚合、本地主权、宿主级跨 CLI 能力——单一厂商结构上永远做不了），附推理
判据提醒：厂商不会帮用户桥接竞品；凡是「只对单一 CLI 有效的增强」默认高危，凡是「跨工具/跨厂商/宿主级」默认防御。但要实证不要教条——用 changelog 证据说话`, { label: '补盲:蒸发测试', phase: '补盲侦察', model: 'sonnet', schema: MOAT_SCHEMA }),
  () => agent(`${CTX}

你是 lens-monetize（变现/付费触发）。商业化项目至今零变现侦察，你补上。
① 扒 Coffee-CLI/Warp/Devin/Cursor 等的定价页与免费付费分界线；重点收集「涨价/gate 引发反噬」事件（尤其 Warp 强制登录出走、免费转付费的导火索与用户原话）
② 社区取样（r/ClaudeAI、HN「你会为哪个 CLI 工具付费」类帖）：区分「天天用但绝不付费」与「愿意月付」的功能类别——ccusage 免费仍流行=可视化难变现的信号，找更多这类信号
产出：
a) pricing_landscape：竞品定价模式速览
b) backlash_cases：gate 反噬案例库（trigger+lesson）
c) paywall_map：13 支柱逐根标 free-attract（免费引流层）/ paid-convert（付费转化点）/ gate-toxic（锁了会中毒），附推理
d) invite_gate_guidance：对 mousse 已有的邀请制/兑换码机制，给出「该锁什么/绝不能锁什么」的具体约束清单`, { label: '补盲:变现', phase: '补盲侦察', model: 'sonnet', schema: MONETIZE_SCHEMA }),
])

return { restraint, moat, monetize }