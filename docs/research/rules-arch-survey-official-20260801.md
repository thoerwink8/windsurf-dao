# AI coding agent 规则/记忆/工作流管理 · 官方生态一手调研

> 2026-08-01 · dao 架构优化调研第一路（官方+主流生态）· 另一路为开源实践面（rules-arch-survey-oss-20260801.md）
> 说明：code.claude.com 与 platform.claude.com 全程 WebFetch 被拒，其内容为搜索索引摘要（已标注）；claude.com/blog、anthropic.com/engineering、GitHub raw、arxiv、cursor.com、docs.github.com、docs.cline.bot 均为直取正文。

## 面 1 · Anthropic 官方

### 1.1 官方机制选型矩阵（最高价值一手件）
《Steering Claude Code: when to use CLAUDE.md, skills, hooks, and subagents》 https://claude.com/blog/steering-claude-code-skills-hooks-rules-subagents-and-more

| 机制 | 加载时机 | 压缩后 | 成本 | 官方指定用途 |
|---|---|---|---|---|
| CLAUDE.md（根） | 会话开始全程驻留 | 压缩后重读 | **High** | 构建命令/目录结构/团队规范 |
| CLAUDE.md（子目录） | 触到该目录时 | 再触才回 | Low | 目录特有约定 |
| **Rules** | 无 `paths` → 会话开始；有 `paths` → **文件匹配时** | 重新注入 | Medium | 具体约束 |
| Skills | 只预载 name/description，调用时载正文 | 共享预算内重注入 | Low | 程序性工作流 |
| Subagents | 隔离执行只回摘要 | — | Low | 侧任务 |
| **Hooks** | 生命周期事件 | **完全绕过压缩** | Low | 确定性自动化 |
| Output styles | system prompt | **永不被压缩** | High | 角色级转变 |

三句原文：
- **"Keep CLAUDE.md under 200 lines, give it an owner, and review changes to it like code."**
- **"Every line loads into every session… whether it's relevant to their task or not. This consumes tokens and dilutes adherence to the instructions that actually matter."**
- **"A real guardrail needs to be deterministic, and the enforcement methods are hooks and permissions."**（软规则失效条件明写：长会话/压力/歧义/prompt injection 下会失守）
- 选型判据："Reach for a path scoped rule over a nested CLAUDE.md file when the instruction regards a cross-cutting concern."

**与 dao 差距**：官方把 always-on 定为 High cost 档、≤200 行、只放索引与事实；dao 把 always-on 当主干（62.4KB ≈ 官方建议量级 10-30 倍）。矩阵可直接当 dao.md 各节归属表。

### 1.2 `.claude/rules/` 作用域机制——**paths glob 原生存在**
```yaml
---
paths:
  - "src/api/**"
---
```
- [索引摘要] "Rules without `paths:` load at session start; rules with `paths:` load only when Claude **reads** a matching file."（触发器是 Read 不是任意工具）
- "An unscoped rule is mechanically identical to putting the content in CLAUDE.md."
- ⚠ **已知实现缺陷** https://github.com/anthropics/claude-code/issues/17204 ：文档写 `paths:` 但某些配置只有未文档化的 `globs:` 生效，pattern **必须加引号否则静默失败**——静默失败的作用域规则=零注入而你以为注入了（dao「零检出≠零存在」）。
- Skills 也支持同一 `paths` 字段。Rules 没有 description 自选档（那档由 skills 承担）。
- **与 dao 差距**：dao 只有「always-on 全量 + 手敲 skills」两档，**中间档（路径作用域自动注入）完全空着**——而 dao.md 大量条款有天然路径锚点（PR 流程→`.github/**`、守卫→`scripts/**`、设计同步→`design/**`、隔离面→`crates/**`）。

### 1.3 Hooks 官方定位
"deterministic control: certain actions always happen rather than relying on the LLM to choose"——与 dao 实测（文字 9-24% vs hook ~100%）同一句话。**官方补的 dao 未用满的点：hooks bypass compaction entirely**——「必须活过压缩」的义务（心跳/续力）正确载体是 hook 不是 dao.md 条款。

### 1.4 Skills 渐进披露官方量化
https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
Anthropic 自己仓库的授权尺寸表：metadata **~100 words**（永远加载）/ SKILL.md **<5000 words 目标 1500-2000**（触发时）/ references/scripts/assets **无上限**（按需/不进 context）。
**`assets/` 的官方定义**："Output files (templates, icons, boilerplate) **not loaded into context**"——dao 的 canonical templates 的准确归位：**模板是被写出去的，不是被读进来的**。

### 1.5 上下文工程判据
https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- 两种失效：过度具体（"creates fragility"）/ 过度模糊。**"the minimal set of information that fully outlines your expected behavior"，且 "minimal does not necessarily mean short."**
- context rot 官方承认：token 越多召回越差，attention budget 是有限资源。
- **对 dao**：dao.md 是「过度具体」侧教科书样本（单次事故完整叙事进 always-on）；「minimal ≠ short」给存根化正名——不是砍到 200 行，是叙事挪走只留判据。

### 1.6 长时程 agent：硬语气 vs 结构约束实测
https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
用了 "It is unacceptable to…" 最强措辞**不够**；解法是换载体——改 JSON："the model is less likely to inappropriately change or overwrite JSON files compared to Markdown files."
**对 dao**：账本/面板全 Markdown——机器要判的部分（在途路数/欠账编号/解冻条件）JSON 化有一手支撑。

### 1.7 Prompt caching 经济学
费率（OpenRouter 直取，与 Anthropic 一致）：cache write 1.25×（5min）/2.0×（1h）；**cache read 0.1×**。
算账（62.4KB≈25k token 估算）：100 轮无缓存 2.5M vs 有缓存 ~279k token 等价（**省 ~89%**）。但 compaction 后重读=再一次 cache write。
**结论**：计费面确实不太贵了；**但缓存一分钱也没省 attention budget**——context rot 与 "dilutes adherence" 按未打折的 25k 计。**瘦身的正当理由已从「省钱」转移到「保注意力+保信噪比」**。拿「反正有缓存」当不瘦身理由=把计费面结论错用到注意力面（L31 同型）。

## 面 1.5 · 学术实证（最意外收获，直接冲击核心假设）

### A. 文件结构对遵守率**没有**可检测影响 —— arxiv 2605.10039
1,650 个 Claude Code 会话 / 16,050 函数级观测。四变量（文件大小/指令位置/架构/文件间矛盾）多重校正后**全部无可检测差异**（大小与冲突有强贝叶斯零支持 BF10=0.05-0.10）。**唯一显著效应是会话进程：每多生成一个函数，遵守对数几率 -5.6%（OR=0.944），非线性。**
**对 dao（本报告最重要一条）**：「瘦身提高遵守率」在最接近的对照实验里没有得到支持。dao 的 9-24% vs ~100% 差的是**形态**不是**篇幅**——决定遵守率的是「有没有挂在必然发生的时刻上」，不是写在第几行。瘦身仍该做（attention/维护性/信噪比是真的），但**别指望它买遵守率**。

### B. 禁令类规则遵守率 0%，模型根本没打开过规则文件 —— arxiv 2607.26819
RepoComplianceBench：49 仓 / 106 issue / 4 前沿模型。

| 规则类型 | 无干预 | 引原文 Quote | 一轮反馈 Feedback |
|---|---|---|---|
| **Refuse（禁止）** | **0%** | 仍 0%（最好 10%） | — |
| **Handoff（关键步骤交人）** | **0%** | **0%** | **0%** |
| Disclose（须披露） | 17-40% | **76-77%** | — |
| Verify（须验证） | 4-92% | — | **90-100%** |

**agent 仅 3.5% 的运行中打开过策略文件；97.6% 违规发生在策略文件从未被打开时。**结论原文："Bans and human gates need enforcement **outside** the agent."
**对 dao 直接映射**：🔒 必止门控/自主边界/「禁止 X」类=Refuse+Handoff——**实证 0%，prompt 层任何干预推不动，必须全部落 hook/permissions/CI**。「派单令首行强制 Read 条款库」=Quote 条件（17-40%→76-77%）、「复审官指出违例后修正」=Feedback 条件（90-100%）——dao 这两个设计拿到实证背书。

### C. 规则更新（事故驱动立法）+22.99pp —— arxiv 2606.12231
83 项目 / 7,310 条规则 / 1,540 次演化事件。77.78% 实践者改规则为纠正 AI 错误；抽 160 次演化实测遵守率 49.14%→72.13%。**dao 立法循环的业界基准值**。

### D. Cursor rules 实证画像 —— arxiv 2512.18925（MSR '26），401 仓，五类分类法（细粒度分布未取到）。

## 面 2 · 主流生态规则形态对照

| 生态 | 作用域机制 | 尺寸约束 | always-on 是默认吗 |
|---|---|---|---|
| Claude Code | `paths:` glob（Read 触发） | CLAUDE.md < 200 行 | 否，标 High cost |
| Cursor | 四模式：alwaysApply/globs/description 自选/@手动 | rules < 500 行 | 否（"sparingly"） |
| Copilot | `applyTo:` glob | "no longer than 2 pages" | 仅 repo-wide 一份 |
| Windsurf | trigger 四值 | **硬上限：全局 6000 字符/workspace 12000** | 否，**物理封顶** |
| Cline | frontmatter glob + UI 可开关 | "keep concise" | 否 |
| AGENTS.md | 就近原则多层嵌套 | 无 | 靠层级 |

**跨生态强共识：五个生态全部把 always-on 标成需要克制的例外档、全部提供作用域触发、四家给硬性尺寸上限。没有任何一家官方推荐把规则主干放 always-on。dao 是本次调研所见唯一把 always-on 当主干的体系**（62.4KB=最宽松上限的 5-10 倍、Windsurf 硬闸的 10 倍）。
AGENTS.md 已是事实标准（60k+ 仓库、20+ 工具原生读、Linux Foundation 治理；OpenAI 自己仓库用 88 个嵌套 AGENTS.md）。

## 面 3 · 多 agent 编排的规则下发

### 3.1 Anthropic 多 agent 系统
https://www.anthropic.com/engineering/multi-agent-research-system ——派单四要素（objective/output format/tools guidance/task boundaries，与 dao 派单契约门同构）；规模启发式写进 prompt 不硬编码；多 agent ≈15× token；"instilling good heuristics rather than rigid rules"。

### 3.2 **subagent 不继承 CLAUDE.md（硬事实）**
- issues #62944/#34572/#59309：项目 CLAUDE.md 只载入父 agent，Task 派出的 subagent **不继承**。
- **最危险**："Subagents may confabulate when asked about CLAUDE.md access, confidently claiming it's loaded when it isn't."——问 subagent「你读到规则了吗」拿不到可信答案。
- 官方替代路：①subagent 定义里内嵌 ②PreToolUse hook 运行时强制。
- **对 dao**：「派单 prompt 第一行强制 Read 条款库」不是礼节，是**唯一的下发通道**——拿到一手依据。

### 3.3 「规则即数据/运行时渲染」业界对应物
- **OpenAI Agents SDK dynamic instructions**：`instructions` 可以是函数 `f(context, agent) -> str` 运行时渲染 https://openai.github.io/openai-agents-python/agents/
- **Policy-as-Prompt**（arxiv 2509.23994）：policy 文档编译成 source-linked policy tree + 运行时监控
- **Awesome Copilot MCP Server**：规则库经 MCP 工具运行时检索载入
- **Cline rules-bank**：规则集当可挂载数据卷
- **Meta-Policy Reflexion**（arxiv 2509.03990）：失败轨迹→结构化谓词纠正规则
- **对 dao**：dao 条款库+元字段已是「规则即数据」雏形，且元字段设计（复发计数/触发点/基线）**业界无对应物——dao 领先**。缺「运行时按角色渲染」一步：官种节本质是 `render(clauses, role)` 函数，可改为派单时由帅渲染出只含该官种条款的一份。

## 特别回答：「模板方式走模板」业界对应物

**有，且是三种不同的东西**：
1. **模板作为产物**（不进 context）= skills 的 `assets/`——dao 的 ccswitch/templates/ 已对齐，且 scaffold-manifest 跨项目机检业界无对应物，**dao 领先**。
2. **模板作为规则骨架**（结构化条款+元字段）= Policy-as-Prompt / Meta-Policy Reflexion——dao 元字段领先，但存储还是 Markdown（对照 1.6：模型更容易乱改 Markdown）。
3. **生成式规则文件** = Claude Code `/init`、Cursor `/Generate Cursor Rules`、skill-creator 插件、awesome-copilot——最成熟的一格。

**一句话**：业界的模板管的是「怎么把规则写好、放对、发出去」，不是「怎么让规则被遵守」。前者 dao 已超前；后者实证只有三条路——**Quote（76%）、Feedback（90-100%）、agent 外确定性强制（禁令类唯一有效路）**。模板化不在这三条里。

## 策略候选（S1-S10）与总排序

**S1 门控类条款全量移出文本层**（→hook/permissions/CI；实证 0%→~100%，唯一必然见效）> **S2 补 `paths:` 作用域档**（五家全有；先造 canary 验机制，#17204 静默失败坑）> **S5 叙事与判据彻底分离**（存根化做彻底）> **S10 会话长度治理升格**（唯一被测出的遵守率杠杆：每函数 -5.6%）> **S4 条款结构化+按官种渲染**（渲染=Quote 条件；分两步：先元字段/官种归属结构化）> **S3 物理字符闸**（必须排在 S2 之后——先有出口再设闸）> S7 AGENTS.md 生成式派生 ≈ S8 账本机器面 JSON 化 ≈ S6 skills 自动路由（观望）；**S9 为遵守率瘦身——不做**（2605.10039 强零支持）。

## 未尽处（调研官自报，压缩保留）

1. code.claude.com/platform.claude.com 七篇官方文档全程不可达，引用来自索引摘要（与 blog 直取正文相符，可信度高；「200 行」的直取来源是 claude.com/blog）。
2. caching 费率非 Anthropic 一手（OpenRouter 直取+多源交叉）。
3. 「17 skills ~1700 tokens」是二手，引用请用官方「metadata ~100 words」。
4. 两篇 arxiv 细粒度分布未取到（PDF 抽取失败）；**Cursor 四模式实际使用占比（多少 rule 是 alwaysApply）没拿到**。
5. Windsurf 字符上限是索引摘要未直取。
6. dao.md ≈20-35k tokens 是估算非实测，缓存账量级可信具体数字不可引用——**建议 /context 或 token counting API 实测一次**。
7. 「dao 是唯一 always-on 主干体系」是调研范围内判断非普查。
8. S1-S10 里只有 S1/S10/S4 有直接实证；**S2 业界五家都做但零量化研究**。
9. **最大未决张力：arxiv 2605.10039（大小无影响）vs Anthropic 官方（大文件稀释遵守）直接冲突**——可能的调和是论文测的大小档位远小于 62.4KB；S9「不做」压在这个未决上，若论文档位只在 2-20KB 间波动则 S9 结论不成立。
