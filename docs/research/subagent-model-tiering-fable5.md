# Subagent 模型档位审计 · Fable 5 时代

> 军师（战略评估官）产出 · 2026-07-12
> 前提模型格局：**Fable 5**（claude-fable-5，Mythos 级，能力在 Opus 之上）> **Opus 4.8** > **Sonnet 5** > **Haiku 4.5**。
> ⚠ 成本口径：Fable 5 与 Opus 4.8 的精确定价我方暂无一手数据，本文所有涉及成本倍数的论断一律标 **[成本待核]**，只做方向性推理，不给价格数字。
> 本报告只产建议，不改任何 agent 定义文件——调档由帅验后执行。

> 🔴 **2026-08-08 状态：档位取值已被取代，方法论仍然有效——读它要分开这两半。**
> **失效的一半**：本文的「opus=4.8 是最强 opus」前提已过期；档位取值的真相源是
> `ccswitch/rules/dao-dispatch.md`（军衔四级制那一行给取值，§档位分工那一节给偏离判据），
> 当前基线为 将=Fable 5 / 校=Opus 5 / **尉=Sonnet 5**（用户 2026-08-08 拍板）/ 兵=Haiku 4.5。
> **仍然有效的一半**：§2.4 那条判据「**档位边界不在『任务是否机械』，在 spec 里代码是否已经写好**」
> 与 §2.5 先锋派单表（机械实现/文档 → sonnet、调研 → sonnet、混合件 → opus、战略 → fable），
> 是 §档位分工那张表的直系祖先——**新表沿用了它的轴，只补了两格**：给 Haiku 那格加了「循环是否定长」，
> 给对抗/判别类那格加了外部实测出处。
> **成本口径也可以销账了**：本文当年标 `[成本待核]` 的价格，官方模型表现已给出
> （Fable 5 $10/$50 · Opus 5 $5/$25 · Sonnet 5 $3/$15 · Haiku 4.5 $1/$5，每百万 token 输入/输出）。

## 一、现状盘点（九大将）

定义文件位置：`D:\frank\windsurf-dao\ccswitch\agents\*.md`（8 个显式 frontmatter）+ 内置通用型（无定义文件）。

| # | Agent | 角色 | 现状档位 | 来源 |
|---|---|---|---|---|
| 1 | dao-strategist | 军师 | **opus**（frontmatter 显式） | `ccswitch/agents/dao-strategist.md` |
| 2 | dao-reviewer-critical | 御史 | **opus**（显式） | `ccswitch/agents/dao-reviewer-critical.md` |
| 3 | dao-reviewer | 监军 | **sonnet**（显式） | `ccswitch/agents/dao-reviewer.md` |
| 4 | dao-brainstormer | 谋士 | **sonnet**（显式） | `ccswitch/agents/dao-brainstormer.md` |
| 5 | dao-spec-writer | 参谋 | **sonnet**（显式） | `ccswitch/agents/dao-spec-writer.md` |
| 6 | dao-plan-writer | 令官 | **sonnet**（显式） | `ccswitch/agents/dao-plan-writer.md` |
| 7 | dao-debugger | 军医 | **sonnet**（显式） | `ccswitch/agents/dao-debugger.md` |
| 8 | dao-worker-batch | 工兵 | **haiku**（显式） | `ccswitch/agents/dao-worker-batch.md` |
| 9 | claude / general-purpose | 先锋（通用实现型） | **未指定 = 继承主会话档**（帅现为 Fable 5 → 先锋静默变 Fable 5） | 内置，无 frontmatter |

配套事实：
- Agent 工具的 model 参数 enum 已含 `fable`（sonnet / opus / haiku / fable）——`fable` 是合法派单档位。frontmatter `model: fable` 是否被 harness 接受**改前需一验**（一次冒烟派单即可）。
- 既有实证（PROGRESS.md:29, mousse-cli v1.20.0）：**sonnet 降档做"明确 spec 的机械实现"，质量与主档无差，已固化 sonnet 为该类任务默认档**。注意：这条实证的对象是 sonnet，不是 haiku——不能拿它替 haiku 背书。
- AGENT_GUIDE.md §四 层级表（战略 opus / 中坚 sonnet / 工人 haiku）写于 Opus 为最强档的时代，Fable 5 出现后"战略层 = 体系可用的最强模型"这一隐含意图与"战略层 = opus"这一字面配置**开始脱钩**——这是本次审计的核心矛盾。

## 二、重点论证

### 2.1 军师（dao-strategist）：Fable 5 还是 Opus？

两个方向都过一遍再下结论。

**方向 A：留 Opus（独立视角 + 省成本）**
- 独立视角论：帅是 Fable 5，军师换 Opus 可获得"不同模型权重的第二视角"，类似 ensemble 多样性。
- 省成本论：Fable 大概率贵于 Opus **[成本待核]**，军师 prompt 又要求最高思考档，单次召唤 token 极重。
- **反驳独立视角论**：subagent 独立性的主要来源是**干净 context + 对抗性 prompt**（军师 profile 明写"假设作者错了反向找证据"），不是模型权重差异。多样性对**判别类任务**（找错、review）有价值；但军师三个工作模式（架构定调 / 攻坚 / 对抗 review）本质是**生成最优判断**——生成类任务上，更强的单模型直接优于更弱的"不同视角"。用 Opus 换来的多样性收益不确定，付出的能力下降是确定的。
- **反驳省成本论**：军师的召唤判据本身就是"决策错了代价 ≥ 100 小时"，且设计定位"稀少召唤，贵但值"——量已被判据锁死。一次架构定调的 token 成本，无论 Fable 比 Opus 贵几倍 **[成本待核]**，相对 100+ 小时开发方向的错误代价都是噪音。成本敏感的档位优化应该发生在高频层（工兵/监军），不在最低频的顶层。

**方向 B：升 Fable 5**
- 军师 profile 自我定位："金字塔顶端""没有别的能替代""给出别人给不了的判断"。当体系内存在比 opus 更强的可用模型而顶端不用，定位自相矛盾——御史的升级阀"我的 High 不够 → 升级 dao-strategist"也随之贬值（升上去的模型没比自己强多少）。
- 长链推理（复杂状态机推导、并发死锁分析、3 次失败后质疑架构）正是模型能力差**最放大**的场景。
- "帅军同档没有增量"的疑虑不成立：帅带满 context 的全局视野但被对话占用注意力，军师带干净 context 的全预算深推理——同档不同位，互补而非重复。

**结论：升 Fable 5，可直接固化**（逻辑必然：召唤判据已把它限定在唯一值得买最强模型的场景；独立视角来自 context 与 prompt，不来自换弱模型）。附带动作：拿到 Fable 定价后复核一次成本假设 **[成本待核]**；frontmatter `model: fable` 先冒烟验证 harness 接受。

### 2.2 御史（dao-reviewer-critical）：对抗深审档位

- 与军师的关键差异：**召唤频率高一个量级**（每个核心模块的 Stage 2 都过御史，军师是稀少召唤），成本敏感度实质更高 **[成本待核]**。
- 御史是**判别类任务**（找隐性 bug / 攻击面）——这正是"不同模型视角"多样性真正有价值的地方：帅（Fable）合成 + 御史（Opus）对抗审 = 双模型视角天然形成，Opus 4.8 做安全深审的能力仍在实现者（sonnet/haiku 工兵）之上两档，"审查者强于实现者"的格局完整。
- 御史 profile 已有升级阀："需要 XHigh 长链推理，我的 High 不够 → 升级 dao-strategist"。军师升 Fable 后，这个阀自动变成"御史打不穿的升 Fable 深审"——极端关键件（密钥处理 / 支付金额 / 权限边界）的顶配保险已有通道，不必把御史整体抬到 Fable。
- **结论：保持 opus（固化），极端关键件走既有升级阀触达 Fable；另开一个低成本试点**——同一核心 diff 双审（opus 御史 vs 临场覆盖 fable 的御史），对比真实 P0/P1 发现数与噪音率，若 Fable 稳定多找出真 P0，再议整体升档。

### 2.3 中间层（监军 / 谋士 / 参谋 / 令官 / 军医）

统一背景：Sonnet 5 在新格局里仍是第三档，承担结构化产出绰绰有余；且五个 agent 的失败都有回打/升级阀兜底，错误可逆、反转成本低——不满足升档的必要条件。

- **监军 dao-reviewer（sonnet，保持·固化）**：Stage 1 是机械核对（逐条勾 spec），Stage 2 找明显 bug——sonnet 是"帅强将轻"官方实证（Opus lead + Sonnet workers 胜纯 Opus 单兵 90.2%）的原配角色。深件已有升级阀到御史/军师。不升不降。
- **谋士 dao-brainstormer（sonnet，保持 + 临场覆盖通道）**：中间层里推理密度最高的一个——需求挖错 = 全链白干。但它与用户多轮交互、延迟敏感，且真正一次定调的判断本就该升军师。规则：默认 sonnet；当探索对象本身满足军师判据（架构级、≥100 小时代价）时，帅**临场覆盖 opus** 派单。这条属"须实证试点"：观察高代价 brainstorm 件的 design 文档返工率，sonnet 与 opus 有无可感差异。
- **参谋 dao-spec-writer（sonnet，保持·固化，设回打率哨兵）**：spec 是整个降档体系的**承重墙**——工兵越弱，spec 必须越好。sonnet 现状运转正常（v1.20.0 链路实证）。哨兵指标：工兵"spec 不清晰"回打率——若持续走高，优先升参谋到 opus，而不是升工兵。
- **令官 dao-plan-writer（sonnet，保持·固化）**：结构化长文档主力，模板性强，sonnet 恰位。不建议 haiku 试点——plan 拆解粒度错误会放大到整条造线，节省的 token 不值反转成本。
- **军医 dao-debugger（sonnet，保持·固化）**：根因分析是推理任务但有强流程护栏（4 阶段强制），且"3 次失败升军师"的升级阀在军师升 Fable 后含金量变高——疑难杂症的深推理保险反而更足了。默认不动；帅对明显棘手的并发/heisenbug 可临场覆盖 opus。

### 2.4 工兵（dao-worker-batch）：haiku 够格吗、边界在哪

- **够格，保持 haiku（固化），但边界必须写清**：
  - **haiku 领地**：spec 含**完整代码模板**（copy-adapt 级——改名 / 格式化 / 套模板写测试 / 批量改 import）。工兵 profile 本身就是"零判断、spec 不清即拒绝"，护栏（拒绝执行 + Stage 1 回打）兜住了 haiku 的能力下限。
  - **sonnet 领地**：spec 明确但**无逐行模板**、需现场写代码的机械实现——这正是 v1.20.0 实证固化的 sonnet 档任务。**不要把这类活派给 haiku 工兵**：实证背书的是 sonnet，不是 haiku。
- 换句话说：档位边界不在"任务是否机械"，在 **spec 里代码是否已经写好**。写好了 → haiku 照抄；没写好 → sonnet 现场写。
- **哨兵指标（持续观测，非一次性试点）**：haiku 工兵的 Stage 1 回打率 / 返工轮次。显著高于 sonnet 基线 → 该类任务回 sonnet，并检讨是不是参谋的 spec 模板不够完整。

### 2.5 先锋（通用实现型，无 frontmatter）：帅派单显式传什么档

先锋是**唯一继承主档**的将——帅升 Fable 5 后，所有不传 model 的先锋派单**静默变成最贵档**，这是当前体系最大的静默成本泄漏点 **[成本待核]**。派单规则（帅侧执行，写进派单习惯）：

| 任务类型 | 显式传档 | 依据 |
|---|---|---|
| 明确 spec 的机械实现 / 文档产出 / 验证循环 | `sonnet` | v1.20.0 实证已固化 |
| 调研 / 盘点 / 侦察（读码总结、文件巡查） | `sonnet`；大规模纯枚举型盘点可试 `haiku` | 判别+摘要任务，不需顶配；haiku 侧标试点 |
| 跨模块设计+实现混合件（无法拆成 spec 的） | `opus` | 需现场判断但不到军师判据 |
| 战略推理 / 对抗验证官 / 模型级重构 | `fable`（或省略=继承，但**建议仍显式写**） | dao.md 既有条款"战略推理可继承主档"，显式写掉歧义 |

**铁律建议：先锋派单 model 字段必填，不传 = 违例**（理由见 §四）。

## 三、建议矩阵（总表）

| Agent | 角色 | 现状 | 建议 | 一句理由 | 固化 / 试点 |
|---|---|---|---|---|---|
| dao-strategist | 军师 | opus | **fable** | 召唤判据锁定"≥100h 代价"场景，能力天花板主导、成本占比是噪音 [成本待核]；独立视角来自干净 context 而非弱模型 | **固化**（改前冒烟验证 frontmatter 接受 `fable`；拿到定价后复核成本假设） |
| dao-reviewer-critical | 御史 | opus | **opus 保持** | 判别类任务多样性有价值（Fable 帅 + Opus 御史双视角）；高频召唤成本敏感；极端件走升级阀触达 Fable | 固化 + **试点**（同 diff 双审 opus vs fable，比真 P0 发现数与噪音率） |
| dao-reviewer | 监军 | sonnet | sonnet 保持 | 官方实证原配角色（lead+sonnet workers 胜 90.2%），深件有升级阀 | **固化** |
| dao-brainstormer | 谋士 | sonnet | sonnet 保持 + 高代价件临场覆盖 opus | 交互延迟敏感；定调级判断本该升军师 | 保持固化；覆盖规则**试点**（指标：高代价 design 文档返工率） |
| dao-spec-writer | 参谋 | sonnet | sonnet 保持 | spec 是降档体系承重墙，现状链路实证正常 | **固化**（哨兵：工兵回打率走高 → 优先升参谋非升工兵） |
| dao-plan-writer | 令官 | sonnet | sonnet 保持 | 结构化模板产出恰位；降 haiku 的反转成本不值 | **固化** |
| dao-debugger | 军医 | sonnet | sonnet 保持 | 4 阶段流程护栏 + 3 次失败升军师（军师升 Fable 后保险更足） | **固化**（棘手并发件帅可临场覆盖 opus） |
| dao-worker-batch | 工兵 | haiku | haiku 保持 | 边界=spec 是否含完整代码模板：有→haiku 照抄；无→sonnet 现场写（v1.20.0 实证对象是 sonnet 非 haiku） | 固化 + **哨兵观测**（Stage 1 回打率对比 sonnet 基线） |
| claude/general-purpose | 先锋 | 未指定=继承主档（Fable 5） | **派单 model 必填**：机械实现/文档 sonnet · 调研 sonnet（枚举型试 haiku）· 混合件 opus · 战略 fable | 唯一静默跟涨点，默认值站在违例那边 | 规则**固化**进 dao.md 派单铁律；haiku 侦察侧**试点** |

## 四、「继承主档」默认值风险 · 结论

**风险面比想象中小，但唯一的口子必须堵。**

1. 九大将里 **8 个已显式声明 frontmatter model**——帅从 Opus 升 Fable 5，这 8 个的成本**一分未涨**。显式声明的既有设计是对的，不需要批量整改。
2. 暴露面收敛于**两处**：① 先锋（claude/general-purpose，无 frontmatter，天然继承）；② 帅临场派单时**忘传 model** 的任何调用。dao.md §帅 已写"派单显式传模型档，不传 = 默认继承主会话最贵档（默认值站在违例那边）"——条款已在，Fable 时代它从"省钱建议"升格为**硬性自检项**。
3. **结论：该改为显式声明，但动作是"规则升格"而非"建文件"**——给内置通用型建 frontmatter 不可行也不必要；正确动作是在 dao.md 派单契约门追加一句：「通用型（无 frontmatter）派单，model 字段必填，缺省视为派单违例」。8 个 dao agent 维持显式 frontmatter 现状即为最佳实践。
4. 附带一致性修订：军师若固化 `model: fable`，需同步更新 `AGENT_GUIDE.md` §四层级表（"战略 opus" → "战略 fable / opus 分层：军师 fable、御史 opus"），避免文档与 frontmatter 脱钩。

## 五、执行清单（帅验后按序执行，本报告不动任何定义文件）

1. 冒烟验证：临场派一个 `model: fable` 的 subagent 确认 harness 接受该值（Agent 工具 enum 已含 fable，frontmatter 路径需实测）。
2. 通过 → `dao-strategist.md` frontmatter `opus → fable`，同步 AGENT_GUIDE.md §四 层级表 + profile 内"token 成本 10-20×"措辞复核 [成本待核]。
3. dao.md 派单契约门追加"通用型派单 model 必填"一句。
4. 开两条试点账：御史双审对比（下一个核心模块 PR）；haiku 侦察型盘点（下一次批量文件巡查），结果记 evolution/PROGRESS。
