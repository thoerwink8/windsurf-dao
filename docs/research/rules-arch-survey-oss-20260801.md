# 外向调研报告：AI agent 规则治理 / 记忆架构 / 自我改进闭环（开源社区与工程实践面）

> 2026-08-01 · dao 架构优化调研第二路（开源实践）· 另一路为官方生态面
> 触发：用户问「dao 主线还能优化吗？模板方式走模板？参考市面最佳实践」
> ⚠ 本文件由帅从调研官交付通知中转录落盘（tasks/*.output 对正常结束 agent 恒 0 字节，首次 Copy-Item 拷了空文件——正是 dao.md:220 那个坑的重演，留此注记）。

## 面一 · 规则膨胀治理

### 1.1 AGENTIF 基准（清华 KEG，NeurIPS 2025）—— dao 的 9-24% 有了外部对照组
- https://arxiv.org/abs/2505.16944 ｜ https://keg.cs.tsinghua.edu.cn/persons/xubin/papers/AgentIF.pdf
- 707 条人工标注指令，取自 50 个**真实** agentic 应用；平均 1723 词（最长 15630 词）、**平均 11.9 个约束/指令**。
- 结论：**SOTA 模型完美遵守率 < 30%**，最差的是**条件约束与工具规格**。
- **与 dao 对照**：dao 实测「文字条款 9-24%」不是写得差，是**行业地板**——且 dao.md 的形态（长指令+大量「当 X 时必须 Y」条件型条款）恰落在 AGENTIF 测出的**最差象限**。靠改措辞提升遵守率的路，学术上已证为死路。

### 1.2 硬性尺寸闸已经是可安装的现成件（三个开源实现）
- **agents-md-max-size**（jonathanong/scripts）—— CI 脚本，**默认 200 行 / 12000 字符**硬上限，扫全仓 AGENTS.md/CLAUDE.md。
- **ctxlint**（YawLabs，MIT）https://github.com/YawLabs/ctxlint —— 30+ 检查项，token-aware，16 种 agent 工具的规则文件；SARIF 输出；`--fix`。
- **AgentLint** https://www.agentlint.app/blog/writing-a-good-agents-md/ —— 七类失效模式 + **每个原则清单最多 7 条** + 根文件 < 200 行。

> **量级参照**：dao.md 62.4KB ≈ 硬闸默认值（12000 字符）的 **5.2 倍**；Vercel 拿到 100% 通过率的索引是 **8KB**；Norsica 建议 ~100 行/文件 ~1500 token。**没有任何公开实践的推荐值与 dao 现状同数量级。**

### 1.3 「规则的生命周期」—— 唯一成体系的退役制度
- https://dev.to/tacoda/the-lifecycle-of-a-rule-567e
- 出生判据：「If I cannot point to the commit, PR, or incident that produced the rule, the rule is on probation.」
- **月度审计三问**：①还记得这条为什么存在吗 ②它防的模式还可能发生吗 ③**过去一个月里删掉它会改变我观察到的任何东西吗**——失败 2 条即候选，3 条全败即删。双飞轮：新增与删除同时转。
- **与 dao 对照**：dao 退役观察线只「打印候选」；元字段有 `n`/`基线` 但没有第③问那一维——三问里唯一有杀伤力的、dao 答不出的。

### 1.4 Chroma「Context Rot」—— 无关规则不是中性负担，是主动伤害
- https://www.trychroma.com/research/context-rot （18 个前沿模型）
- ①准确率随输入长度**非均匀**下降，远未到标称上限就掉 30-50%；②**仅一个 distractor 就拉低准确率**；③**反直觉——连贯、结构良好的输入比打乱的输入更严重劣化注意力**。
- **与 dao 对照**：第③条最刺——dao.md 是高度结构化连贯长文本，恰是测出的**最坏形态**；第②条意味着与当前任务无关的那 90% 条款**在主动干扰**。

## 面二 · 记忆架构

### 2.1 Vercel 实测：**「模型自己决定要不要加载」是整条链上最脆的一环**（本次调研最重要的数据）
- https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals ｜ HN https://news.ycombinator.com/item?id=46809708
- 四档对照（Next.js 16 新 API，刻意选训练数据外）：

| 配置 | 通过率 |
|---|---|
| 无文档基线 | 53% |
| Skill（默认） | **53%（+0pp，默认触发率仅 44%）** |
| Skill + 显式指令 | 79%（触发率 95%+ 但天花板仍 79%） |
| AGENTS.md 索引（40KB 压成 8KB） | **100%（80% 压缩零损失）** |

- 机理：「passive context beat active retrieval」——消掉了「要不要查文档」这个决策点。脆弱性自陈：措辞微调导致行为大幅摆动。
- **与 dao 对照 · 最反直觉**：「运行时按上下文检索注入」方向被数据打脸。dao 的 skills 全 `disable-model-invocation` + 用户手敲，**歪打正着绕开 44% 触发率坑**——用户的手指代替了模型的判断。这一点不该动。

### 2.2 Letta / MemGPT 三层记忆 —— 「层」按**可写性**分，不按内容类型
- https://www.letta.com/blog/agent-memory/
- Core（in-context，agent 可自改，**有容量上限**）/ Recall（全量史可搜）/ Archival（向量召回）；function call 自主管理层间迁移。
- **与 dao 对照**：dao 三层已存在（dao.md≈core / skills≈archival / memory+evolution≈recall），但 **core 层缺「可自改+容量上限」两个核心性质**——dao.md 只增不减且无闸，正是 MemGPT 用容量上限强制解决的问题。

### 2.3 Anthropic「Dreaming」（2026-05-06）—— 把「收割+退役观察线」做成自动异步过程
- 二手详述 https://www.mindstudio.ai/blog/claude-dreaming-feature-self-improving-agent-memory
- 形态：会话间异步跑，读 transcripts+memory store → 抽模式/**合并重复/替换过期**/写新条目 → 产出重组后的记忆层，团队 **approve/reject/modify** 再部署。
- Harvey 内测任务完成率约 6 倍（**厂商自报无方法学**）。风险（Anthropic 自陈）：错误指令会被固化并自动应用于未来所有会话。
- **与 dao 对照**：dao-harvest = dreaming 的「抽模式」半边+人工批准；**缺「合并重复/替换过期」那半边**——治膨胀的另一半。可直接抄的形态。

## 面三 · 自我改进闭环

### 3.1 AutoManual（NeurIPS 2024）—— 结构化规则 + 显式 CRUD
- https://arxiv.org/abs/2405.16247
- Planner / Builder（通过**结构化规则系统**在线增删改）/ Formulator（编译成人读手册）；防幻觉：case-conditioned prompting——改规则必须条件在具体 case 上。ALFWorld GPT-4-turbo 97.4%。
- **与 dao 对照**：三角色 dao 都有（帅/收割/dao.md），但 **Builder 没有「规则系统」数据结构**——收割产出散文只能 append，AutoManual 的 schema 对象能 merge/delete。**「只能 append」是数据结构决定的，不是纪律决定的**——对 dao「规则集只增不减是结构必然」的最强外部佐证+破法。

### 3.2 「When Generic Prompt Improvements Hurt」—— 唯一真做了规则组消融的公开工作
- https://arxiv.org/html/2601.22025v2
- Qwen 2.5 在 RAG 合规任务：**基线 86.7% → 加通用规则后 30.0%（-56.7pp）**；同批规则在结构化抽取任务大幅正收益（0%→93.3%）。结论：**通用 prompt 增补不产生单调改进**——同一条规则 A 任务救命 B 任务灾难。
- **与 dao 对照**：dao.md 62.4KB **从未被消融**，其中一定有条款组在某类任务上造成两位数净损失，且无机制能发现（元字段只记「防住什么」不记「弄坏什么」）。

### 3.3 ExpeL —— 「抽洞见」与「存轨迹」是两件事，且都要
- https://arxiv.org/abs/2308.10144
- 抽象 insight + 成功轨迹向量库一起召回，组合优于单独任一。⚠ 反向证据：有研究称 episodic-only（只留原始 rollout、关掉抽象）能匹敌或击败所有 consolidator（一手 URL 未定位，见未尽处 7）。
- **与 dao 对照**：dao 收割是纯抽象路线**没留具体 case**；evolution CSV/叙事账本≈episodic 层但不参与注入。

## 面四 · 结构化规则 vs 自然语言规则

### 4.1 三档投递机制（**本报告核心结论**）

| 档 | 谁决定加载 | 实测 | 代价 |
|---|---|---|---|
| 模型决定（Skills / agent-requested） | 模型 | 触发率 44%，天花板 79% | 无关时零成本 |
| 永远在场（AGENTS.md / dao.md） | 无人决定 | 100%（8KB 时）；受 context rot + AGENTIF <30% 双重侵蚀 | 每轮全额付费 + distractor 伤害 |
| **harness 决定**（Cursor auto-attached globs / Claude Code hook 注入） | **代码，非模型** | **无公开对照数据** | 无关时零成本，命中时确定性 100% |

- Claude Code hooks 确定性注入：https://code.claude.com/docs/en/hooks
- 社区共识句：**「Rules in prompts are requests. Hooks in code are laws.」** https://techtrenches.dev/p/your-claudemd-is-a-wish-list-not
- **与 dao 对照**：dao 把「机制>文字」用在**检查**没用在**投递**。第三档是 dao 未踏进的疆域，且不与 Vercel 负面结论冲突（Vercel 打的是「模型决定」档）。dao 的 `触发:` 元字段**已经是这个字段**，只差消费它的 runtime。

### 4.2 AgentLint 七类失效模式
①含糊 ②矛盾 ③陈旧引用 ④无界章节 ⑤语言漂移 ⑥**缺执行面（规则没有对应 CI/hook/permission）** ⑦弱可测性。dao 的 `触发:` 分级比它细，但没做成全库条款定期扫描报表（`触发:无` 占比/趋势）。

### 4.3 ctxlint 的两个检查 dao 应直接抄
- **`dead hooks`**：扫 settings 里指向已不存在脚本的 hook/permission——「a dead gate silently no-ops」。dao 正把身家压在 hook 上：死 hook 与全过 hook 在机器可读通道上不可区分（与 mousse verify-all 退出码条款完全同构）。
- **`session-memory-index-overflow`**：MEMORY.md 超 **200 行 / 25KB session-load cap** 时超出部分对 agent 不可见——硬事实上限，进备案清单。

### 4.4 结构化规则标准 —— 有 schema，但没有生命周期字段
- **aicodingrules.org**：`id`/`applies_when`/`triggers`/`priority`/`guidance`(Markdown) 等；三级优先级。**明确缺失**：版本、废弃策略、token 预算、生命周期元数据。
- **与 dao 对照**：`applies_when`/`triggers` 正是第三档所需机器可判字段；`priority` 解决 dao 靠散文措辞处理的冲突。**生命周期字段是全行业空白，dao 的 `[n=…][基线:…][自定@…]` 领先任何公开规范**——dao 可对外输出的部分。

## 策略候选清单

| # | 策略 | 出处 | 预期收益 | 代价 | 建议 |
|---|---|---|---|---|---|
| **S1** | **dao.md 字节硬闸**（超限即红，加新须先腾预算，「一进一出」自动成立） | agents-md-max-size · Vercel 8KB=100% | 「只增不减」从纪律问题变**闸问题** | 需再一次大压缩；**闸值必须用户拍板**（AI 自划及格线命中否决项①） | **强烈推荐** |
| **S2** | **第三档投递：hook 驱动确定性条款注入**（按动作/文件/分支由代码判定注入条款子集） | Cursor auto-attached · CC hooks · Hooks are laws | 既保 100% 又消 context rot；`触发:` 元字段已是这个字段 | 工程量最大；误判=静默失效（配 S5）；**无直接实证** | **推荐（必须先做 S1**，否则=把 62KB 拆成几片 62KB） |
| **S3** | **条款结构化混合**（YAML frontmatter 机器面 + Markdown body 叙事） | AutoManual · aicodingrules.org | 解锁 merge/delete/dedupe（只能 append 是数据结构决定的） | 迁移成本高；全结构化损失叙事 | **推荐做混合**不做全结构化 |
| **S4** | **dreaming 式离线整编**（收割扩「合并重复/标记过期」半边，产出候选重组版交用户 approve） | Anthropic Dreaming · AutoManual | 补退役观察线「只打印不动手」缺口 | 错误固化风险；两护栏：①产出是 diff ②改一条必须引具体 case | **推荐** |
| **S5** | **死闸检测**（扫 hook/permission 指向脚本存在性、机检档条款检查器真跑过） | ctxlint dead hooks | 死 hook 与全过 hook 机器不可区分 | 极低 | **强烈推荐·优先级最高** |
| **S6** | **条款消融测量**（leave-group-out 测每组净贡献） | Generic Prompt Hurt | 唯一能答「防住什么/弄坏什么」 | 需任务评测集（没有）；结论随代际过期 | **观望**（可先对最可疑 2-3 组做最小版 A/B） |
| **S7** | **生命周期第③问做成收官简报槽位**（删掉它会改变过去一个月观察到的任何东西吗） | dev.to/tacoda | dao 元字段答不出的唯一维度 | 纯人判 | **有条件推荐**：槽位档不做新条款 |
| S8 | 全面转向按需检索式规则加载 | —— | —— | —— | **不适用·有反证**（44%/79% vs 100%；skills 手敲机制不该动） |
| S9 | 改写为更强措辞提升遵守率 | —— | —— | —— | **不适用·有反证**（AGENTIF 行业地板；措辞微调大摆动） |

## 未尽处（调研官自报）

1. **第三档与 always-on 的对照实验没找到**——S2 收益最大而恰恰无直接实证。
2. **>10KB 多年演进多 agent 规则语料的治理实证不存在**——dao 规模在公开世界无同类；dao 的 9-24% vs ~100% 那组数是稀缺资产。
3. **规则有效性归因（counterfactual）在 agent 规则语料上零公开实践**。
4. 「dao.md=Chroma 最坏形态」是外推（Chroma 测检索非指令遵守），效度未验。
5. 「skills 手敲绕开 44% 坑」机理成立但 dao 从未测过自己 skills 实际使用率。
6. 「只能 append 是数据结构决定的」是推断因果，可能反向。
7. faulty-memory 篇（episodic-only 击败 consolidator）两次抓取失败仅凭摘要——若真是 S4 重要反证，采纳前先核实。
8. AutoManual 字段级细节疑似二次概括，采纳 S3 前读原文 §3。
9. Harvey 6 倍是厂商自报，不作 S4 收益依据。
10. 「74% AGENTS.md 浪费时间」经核实无支撑，已剔除。
11. dao 现状数字来自派单令转述未读原文核实。
