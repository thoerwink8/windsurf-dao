# dao 自动行为体系设计

> 道常无为而无不为。用户无为，AI 无不为。

## 状态：✅ v1 已实施（2026-06-17）· v2 待 v1 实战验证后跟进

> 第 1-4 轮 loop 研究迭代见下；用户「直接执行」后落地 v1。实施记录见文末「## v1 实施记录」。

## 问题域（含前提纠正）

用户的原始担忧：「hook 只有工具调用（get 操作）才走，纯对话没有触发判断；skill 行为可能和 hook 重复；其他 skill/command 是否也需要同样处理。」

**第 1 轮纠正了第一个前提**：hook **不是**只在工具调用时触发。`UserPromptSubmit`（每条用户消息提交时）和 `Stop`（每次 AI 回复结束时）在**每个回合**都触发，纯对话同样覆盖。dao 现有的 `dao-cn-title.js` 就挂在 `UserPromptSubmit` 上，每条消息都跑。所以「纯对话无触发」是认知盲区，不是平台限制。

真问题精炼为三个：
1. **触发可靠性**：dao 的核心自动行为（distill / verify / 教训回顾）目前靠 AI 在长对话中「记得」dao.md 的软指令，会衰减。如何让触发变可靠？
2. **机制分工**：hook / skill / rule / command 四者职责边界如何划清，不重叠、无盲区？
3. **覆盖面**：除了 distill，还有哪些 skill/command 该从「用户手动调」升级为「合适时机自动做」？

---

## 事实层：Claude Code hook 事件权威能力表

来源：[官方 hooks 文档](https://code.claude.com/docs/en/hooks)（2026-06 核实，已剔除搜索引擎聚合的疑似幻觉事件）。

| 事件 | 触发时机 | 能否注入上下文 | 能否阻断/续推 | 设计价值 |
|---|---|---|---|---|
| **UserPromptSubmit** | 用户提交每条消息、AI 处理前 | ✅ `additionalContext` | ✅ block（30s 超时，比别的短，因为它阻塞每轮处理） | **回合起点的万能注入点**——纯对话也触发 |
| **Stop** | AI 回复结束（回合终点） | ✅ `additionalContext`（非阻断式反馈，让对话继续） | ✅ block（强制 AI 继续，**有 loop 风险**） | **回合终点的反思点** |
| **SubagentStop** | subagent 结束 | ✅ | ✅ block | 含 `agent_id`/`agent_type` |
| **SessionStart** | 会话开始（startup/resume/clear/**compact**） | ✅ `additionalContext`，可 `reloadSkills`/`watchPaths` | ❌ | compact 后注入回点——配合 PreCompact 救教训 |
| **SessionEnd** | 会话终止 | ❌（会话已结束，无法注入） | ❌ | 只能做副作用（清理/落盘），**不能让 AI distill** |
| **PreCompact** | 上下文压缩前 | ❌（文档未述 additionalContext） | ✅ block | 教训即将随上下文丢失的最后信号 |
| **Notification** | 权限提示/空闲提示等 | ❌ | ❌ | 纯副作用 |

**关键推论**：
- 回合级触发的两个支点是 `UserPromptSubmit`（起点）+ `Stop`（终点）。
- distill 属于「终点」语义，但 `Stop` 有 loop 风险（见下「血泪约束」）；`UserPromptSubmit` 在下一回合起点检测「上一回合是否该沉淀」更安全。
- `SessionEnd` 不能注入 → 无法靠它驱动 distill。会话级 distill 只能靠「下一回合起点的 UserPromptSubmit」或「关键词检测收尾信号」。
- `PreCompact`（不能注入）+ `SessionStart(source=compact)`（能注入）配对：压缩前落标记，压缩后回点提醒，可救「长对话教训随压缩丢失」。

### 血泪约束（来自 memory / 现有 hook）

- **Stop hook 会卡死会话**（[[ralph-loop-disabled]]）：官方 ralph-loop 插件的 Stop hook 因无条件 block 导致死循环，已全局禁用。→ Stop hook 若用，**只注入 additionalContext 绝不无条件 block**，且必须用状态文件保证「同一条件每会话最多触发一次」。
- **UserPromptSubmit 30s 超时**：它阻塞每轮处理，hook 必须轻量。`dao-cn-title.js` 的范式可复用：状态文件 + 冷却时间 + 任何异常 exit 0 优雅降级。
- **PowerShell BOM 坑**（[[claude-settings-self-heal]]）：改 settings.json/hook 注册时防 BOM。

---

## 事实层：现有 dao 自动机制盘点

### 已挂的 hook（5 个注册，6 个脚本）

| 事件 | matcher | 脚本 | 作用 |
|---|---|---|---|
| PostToolUse | `Edit\|Write\|MultiEdit` | dao-glob-gate.js | 改代码→提醒 dao-quality 质量门；改 dao 元文件→提醒 dao-meta 三关 |
| PostToolUse | `Bash` | dao-tool-nudge.js | 绕道 shell 搜文件→提醒用 Grep/Glob/Read（Grep-first） |
| UserPromptSubmit | （无） | dao-cn-title.js | 首条消息生成中文会话标题 |
| SessionStart | `startup\|clear\|resume` | dao-remove-session.js | 会话启动清理 |
| SessionStart | `startup` | dao-codegraph-ensure.js | 启动时确保 codegraph（120s 超时） |

**观察**：hook 已经是 dao「确定性触发」的成熟载体，且已验证 `additionalContext` 注入路径有效（工具选择/元层守卫两个 nudge 实际在塑造行为）。UserPromptSubmit 已被占用但只做标题——**有扩展空间**。

### 7 个 skill 的现有触发方式

全部靠 `description` 语义被 AI 判断加载（model_decision 性质）。无一有确定性触发。

### 12 个 command

dao-commit, dao-distill, dao-doc, dao-remove, dao-thread-tree, dao-dev, dao-evolve, dao-cycle, dao-autopilot, dao-superpowers, dao-loop, gs——全部 `/` 手动调。

---

## 框架层：hook / skill / rule / command 四机制分工

把四者放在「可靠性 × 上下文成本 × 触发方式」三轴上：

| 机制 | 可靠性 | 上下文成本 | 触发 | 本质职责 |
|---|---|---|---|---|
| **rule**（always_on） | 软（长对话衰减） | 永久占用（每轮在 system prompt） | 永远在场 | **原则**（principle）|
| **rule**（model_decision/glob） | 较软 | 加载前为零 | AI 判断 / 文件路径 | 领域原则 |
| **skill** | 按需 | 加载前为零，加载后全文 | AI 判断 OR 显式调 | **内容**（how）|
| **hook** | 硬（确定性） | 零（外部进程，只在触发时注入短提醒） | 固定生命周期事件 | **触发**（when）|
| **command** | 手动 | 零 | 用户敲 `/cmd` | 用户显式入口 |

**核心洞见（本轮最重要产出）**：
> **Hook 管「何时」，Skill 管「如何」，Rule 管「何为」，Command 管「用户显式」。**

不重叠的关键 = **职责不越界**：
- hook 只注入**短指针**（「该 distill 了→走 dao-evolution 三层路由」），**不**嵌入完整流程；
- skill 只放**富内容**（三层路由怎么走），**不**自我触发；
- 二者拼合：hook 让触发可靠，skill 让执行正确。**重叠只发生在 hook 试图塞流程、或 skill 试图自触发时。**

这正是用户直觉「hook 和 skill 是不是重复了」的解答：**不重复，是「触发」与「内容」的正交分工**。dao-tool-nudge（hook 短提醒）+ AI 改用 Grep（行为）已验证此模式可行。

**软硬边界的诚实声明**：hook 注入 additionalContext 仍是「软」的——AI 读到可不照做（不像 `block` 那样硬）。但实测现有 nudge 确实可靠塑造行为。真正的硬强制（block）有 loop 风险且违 dao「无为不强为」。故定位：**hook 让触发可靠（提醒必现），执行仍由 AI 判断**——这与道法自然一致，不追求机械强制。

---

## 设计层：候选方案（第 1 轮初稿，待后续迭代）

### 方案 A：统一「节律」分发 hook（倾向）

仿 dao-tool-nudge 的单分发器模式，挂一个 `dao-rhythm.js` 在 `UserPromptSubmit`，扫描信号→注入对应**短指针**：

| 信号（扫 prompt 文本 / 会话状态） | 注入的短指针 | 落地到哪个 skill |
|---|---|---|
| 收尾词（push/好了/完成/搞定/下次/睡了/谢谢） | 「本会话若有未沉淀洞察→走 dao-evolution 三层路由；纯执行无洞察则跳过」 | dao-evolution |
| 回顾词（之前是不是/遇到过/记得吗/为什么当时） | 「先搜 memory 索引 + docs/evolution，再答」 | dao-evolution |
| 新开放需求（长、含"我想做/重构"） | 「解法不清→先过 dao-brainstorm，别直接写码」 | dao-brainstorm |

配合 `Stop` hook 仅做一件事（只注入不 block）：检测「本回合改了代码/改了 dao 元文件，但 transcript 无构建/测试记录」→ 注入「声明完成前过 dao-verify」。状态文件保证每会话每条件最多一次。

**为道日损**：一个分发器 + 一个极克制的 Stop，而非散落多 hook。对齐 [[evolution-unified-entry]]（统一入口）。

### 待验证的开放问题
- [ ] 单分发器 vs 多 hook：单个更省（减法）但耦合；多个更可测但散。倾向单个，需确认可测性。
- [x] **【第 2 轮已解决】Stop hook 砍掉**。官方文档证实：Stop 注入 additionalContext **会 re-invoke Claude**（「injects the context, re-invokes Claude, and the conversation continues」）→ 每回合终点强制续推 = loop 风险，正是 [[ralph-loop-disabled]] 卡死的根因；带 `decision:block` 则整回合中止（突兀打断用户）。两种模式对节律场景都不适用。**结论：所有生命周期触发归到 UserPromptSubmit（回合起点），不用 Stop。**
- [ ] UserPromptSubmit 注入的指针出现在「AI 处理前」，但 distill 语义在「回合后」——指针说的是「上一回合该沉淀」，措辞要对（检测的是**本条消息的收尾信号**，沉淀的是**之前的工作**）。
- [ ] 关键词扫描的误触率：收尾词「好了」可能是语气词。需降噪策略（类似 tool-nudge 的豁免逻辑）。
- [ ] 是否需要 `turn count` / 时间信号？hook stdin 无直接回合数，需从 transcript_path 读行数估算——成本与收益待评估。

---

## 分诊层：每个 skill / command 的自动化定位（第 1 轮首过，待精修）

判据轴：(A) hook 确定性触发 / (B) AI 判断加载（skill 现状）/ (C) 保持手动 command / (D) 收进 rule。

| 名称 | 类型 | 现状 | 首过定位 | 触发条件 |
|---|---|---|---|---|
| dao-evolution（distill/recall） | skill | AI 判断 | **A+B**：hook 触发 + skill 执行 | 收尾词→distill；回顾词→recall |
| dao-verify | skill | AI 判断（慎终如始半自动） | **A+B**：Stop hook 辅助 | 改码/改元文件但无构建测试记录 |
| dao-brainstorm | skill | agent 已「Use proactively」 | **B**：保持 AI 判断 | 开放需求 |
| dao-plan | skill | AI 判断 | **B**：保持（承 brainstorm） | design 确认后 |
| dao-review | skill | superpowers 流程内 | **B/C**：AI 判断 + 重器门控 | worker 完成后 |
| dao-worktree | skill | superpowers 流程内 | **C**：手动/流程内 | 隔离需求 |
| dao-design-taste | skill | UI 任务加载 | **A+B**：glob-gate 可扩展 | 改 .tsx/.css/.vue→nudge |
| dao-distill | command | 手动 | **保留 command + 加 A 触发** | 同 dao-evolution |
| dao-cycle | command | 手动 | **C**：重器，显式触发 | — |
| dao-autopilot | command | 手动 | **C**：重器，显式触发 | — |
| dao-superpowers | command | 手动 | **C**：重器门控 | — |
| dao-evolve | command | 手动 | **C**：跨会话审计，人驱动 | — |
| dao-commit | command | 手动（用户说"提交"触发） | **C**：手动入口已足；commit 是发布决策，不宜自动 | — |
| dao-doc | command | 手动 | **C**：文档生成重，显式触发 | — |
| dao-remove | command | 手动 | **C**：纯工具（标记删会话），手动 | — |
| dao-thread-tree | command | 手动（处理 Open Threads） | **C 处理 + A 触发上游**：它*回顾*线索；但它依赖的「实时中断感知→自动写 Open Threads」是 vaporware（见下），那一步才是节律 hook 的活 | 上游「中断感知」归节律 hook |

---

## 自检（第 1 轮）

- **道法自然**：方案 A 用「最小机制（一个分发器）覆盖最大面（所有回合）」，倾向成立。但关键词扫描有「强为」嫌疑（硬猜用户意图），需降噪到「只在高置信信号注入」。
- **重叠/盲区**：四机制分工框架已划清「触发 vs 内容 vs 原则 vs 显式」，无明显重叠。盲区：纯对话中「无任何信号词」的回合仍无触发——但这是**应该的**（无信号即无需动作，强行每轮注入是 context 污染）。
- **过度设计风险**：auto-distill 若每回合跑会制造噪音教训（违 dao-distill「为沉淀而沉淀」反模式）。对治：hook 只在收尾信号注入，且指针明说「纯执行无洞察则跳过」，把「有无洞察」的细判留给 AI。

## 横向对照：业界规则触发机制（第 2 轮）

调研 Cursor / Windsurf / Copilot / Codex 四家的规则自动触发设计，聚焦「触发维度」。

| 工具 | 触发机制 | 防膨胀手段 | 有无「生命周期时机」触发 |
|---|---|---|---|
| **Cursor** `.mdc` | 三字段（alwaysApply/globs/description）组合推出 4 档：Always / Auto-Attached(glob) / Agent-Requested(模型判断) / Manual | — | ❌ |
| **Windsurf** rules | 显式 4 档：always_on / glob / model_decision / manual | 字符硬上限（global 6K / workspace 12K per file） | ❌ |
| **Copilot/VS Code** | `applyTo` glob 单字段统三态（`**`=always / 具体 glob / 缺省=manual） | — | ❌ |
| **Codex** `AGENTS.md` | 纯目录层级拼接（root→cwd，深层就近胜），无触发档位 | 字节上限 32 KiB | ❌ |

**收敛设计（多家验证的方向）**：
1. **四档触发轴**（Always / glob / model-decision / manual）是 Cursor↔Windsurf 逐档对应的强共识——dao 的 Windsurf 侧 rules 已用这 4 档，命中收敛。
2. **AGENTS.md 跨工具开放标准**，四家全支持，「目录层级即作用域、就近者优先」是零配置触发的收敛方案。
3. **显式体积上限防 rule bloat**（Windsurf 6K/12K、Codex 32KiB）——业界用工程硬约束而非纯倡导。dao.md 目前无硬上限，可补。
4. **少量 always-on + 其余按需**（Anthropic 点名 Claude Code 为范例）——dao 的「always_on 根基 + skill 渐进披露」已命中。

**最强战略发现（本轮核心）**：
> **四家的规则系统全都只解决「哪些规则附到哪些上下文」（glob 文件匹配 / 模型判断相关性），没有任何一家有「在对话生命周期的某个时机自动做某事」的能力。**

「在收尾时 distill」「在新任务前 recall」这类**时机驱动**的行为，不是规则系统能表达的——它们只能表达「在某类文件上下文里带上某规则」。时机驱动**只有 hook 生命周期能做，而 Claude Code 是这四家里唯一有 hook 的**。

**推论**：dao 的自动行为野心（生命周期时机触发）**超出任何规则系统所能**，是 dao 在 Claude Code 宿主上的**独有战略空间**。规则四档（借鉴业界）解决「带什么知识」，hook 节律（dao 独创）解决「何时动作」——两者正交，共同构成 dao 完整的自动行为体系。

来源：[Cursor rules](https://cursor.com/docs/rules)、[Windsurf](https://docs.windsurf.com/windsurf/cascade/memories)、[Copilot](https://code.visualstudio.com/docs/copilot/customization/custom-instructions)、[Codex AGENTS.md](https://github.com/openai/codex/blob/main/docs/agents_md.md)、[Anthropic context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)。

---

## 关键发现：「中断感知」是 vaporware（第 2 轮）

dao-thread-tree 和 dao-autopilot 都声称存在「对话中的实时中断感知机制（实时检测对话偏离，自动把被中断线索写入 TODO.md 的 Open Threads）」。但 grep 全 ccswitch：**该机制只在这两个 command 里被*引用*，没有任何 hook / rule *实现*它**。

这是「声称存在但无可靠触发」的活标本——典型的「靠 AI 记忆的软行为」，长对话必然衰减。它恰恰是节律 hook 该接管的第一候选：UserPromptSubmit 检测到「本条消息明显切换了话题、而上文有未闭合的决策/任务」→ 注入「把被中断的线索记到 TODO.md Open Threads」。

**意义**：这验证了整个设计的必要性——dao 里已经存在「想自动、但只是写在文档里靠 AI 自觉」的行为，它们就是当前体系的盲区。把它们收编进节律 hook = 把 vaporware 变成确定性触发。

---

## 方案 A 精炼版（第 2 轮 · Stop 已砍）

**载体收敛到两个已验证的 hook 事件**，不引入 Stop：

```
UserPromptSubmit ── dao-rhythm.js（新增；与 dao-cn-title.js 并存于同事件）
  扫描「本条 prompt 文本 + 轻量会话状态」→ 高置信信号才注入 ONE 短指针：
    · 收尾词(push/好了/完成/搞定/睡了)         → 「有未沉淀洞察→走 dao-evolution 三层路由；纯执行则跳过」
    · 回顾词(之前是不是/遇到过/记得吗)          → 「先搜 memory 索引 + docs/evolution 再答」
    · 新开放需求(长+我想做/重构, 解法不清)       → 「先过 dao-brainstorm，别直接写码」
    · 话题切换+上文有未闭合决策/任务            → 「把被中断线索记入 TODO.md Open Threads」(收编中断感知 vaporware)

PostToolUse ── dao-glob-gate.js（已存在；扩展）
    · 改前端文件(.tsx/.css/.vue/.svelte)        → 增「过 dao-design-taste」nudge（现仅有 quality/meta）

SessionStart(source=compact) ── （可选，后续轮评估）
    · 压缩刚发生 → 注入「若压缩前有未沉淀教训，从 transcript 回点」(救长对话教训丢失)
```

**与现有四机制的关系（回答用户「是否重复」）**：distill 这一个行为被四处触及，但各司其职、不重叠——
- `/dao-distill` command = 用户**显式**入口
- dao-rhythm hook = 自动**何时**（确定性触发）
- dao-evolution skill = **如何**（三层路由流程）
- dao.md「各复归其根」rule = **何为**（知识归位原则）

当前的病：dao.md rule 同时兼了「触发」（软、衰减）、command 又重复了内容。**redesign 后**：rule 只述原则 + 指向 skill；hook 独占触发；skill 独占内容；command 是手动入口。**这就是用户直觉「是不是重复了」的根治——不是删掉谁，是让四者各归其位（朴散则为器）。**

---

## 触发可靠性分层（第 3 轮 · 反者道之动）

> 反者道之动。这一轮对前两轮的设计热情做批判性收敛——自主迭代最大的风险是越做越多。

把所有候选自动行为按**触发信号的可靠性**分三层，只有高层值得做 hook：

| 层 | 触发信号 | 可靠性 | 噪音 | 处置 |
|---|---|---|---|---|
| **T1 工具事件** | 具体工具调用 + 文件路径（改码/改元文件/改前端） | 高（信号确定无歧义） | 极低 | **做 hook**（PostToolUse，已有 glob-gate，扩展即可） |
| **T2 高置信对话词** | 明确的指示词（"之前/记得吗/为什么当时"=回顾） | 中高（词具体） | 低 | **谨慎做 hook**（UserPromptSubmit，仅最高置信信号） |
| **T3 模糊/重活** | 软信号（"好了"=收尾？话题切换=中断？） | 低（歧义大） | 高 | **不做 hook**，留 rule/skill/command（靠 AI 判断） |

**核心修正（对自己前两轮的 loss）**：第 1/2 轮的「节律分发器扫 4 类信号」把 T2、T3 混在一起，过度自信关键词扫描能可靠识别「收尾」「中断」。**实际上 distill 的「收尾词」和中断感知的「话题切换」都是 T3——歧义大、噪音高，硬塞进 hook 会制造误触污染。** 为道日损：砍掉 T3 的 hook 化。

### 逐项重判

| 候选自动行为 | 层 | 终判 | 理由 |
|---|---|---|---|
| 改前端→design-taste | T1 | ✅ 做（扩展 glob-gate） | 信号确定，高值 |
| 改码→verify/质量门 | T1 | ✅ 已有 | 已验证有效 |
| 改元文件→meta 三关 | T1 | ✅ 已有 | 已验证有效 |
| **回顾词→搜 memory/evolution** | T2 | ✅ 做（新 dao-rhythm.js） | **最高值 T2**：正是「教训迁移到 memory」的闭环出口——存了要被想起才有意义；信号具体、噪音低；dao.md 现无此规则（真空白） |
| 收尾→提醒 distill | T3→T2 边界 | ⚠️ 降级：**仅强收尾信号**（"收工/睡了/今天到这" + 刚发生 git push），且指针明说"无洞察则跳过" | distill 需判断「有无真洞察」，全自动违「为沉淀而沉淀」；保留极保守提醒，判断权留 AI |
| 话题切换→写 Open Threads（中断感知） | T3 | ❌ 不做 hook | 需「上文有无未闭合决策」的有状态判断，无状态 hook 做不可靠——它正因为难才一直是 vaporware，假装关键词能解决是自欺。改为 dao.md 一句软规则（AI 判断）或留 dao-thread-tree 手动 |

**收敛结果**：hook 层只承接 **T1（全部，扩展现有 glob-gate）+ T2 回顾（新增极简 dao-rhythm.js）+ 一个保守的 T2 边界 distill 提醒**。比第 2 轮方案 A 的「4 信号分发器」显著瘦身。

---

## 单分发器 vs 多 hook（第 3 轮拍板）

收敛后 UserPromptSubmit 上的对话信号只剩 2 个（回顾 + 保守收尾），**不需要大分发器**。最小足迹方案：

- `dao-cn-title.js`（UserPromptSubmit，已有）— 保持原职，不动。
- `dao-rhythm.js`（UserPromptSubmit，**新增**）— 只扫回顾词 + 强收尾信号，注入≤1 短指针。与 cn-title 并存（同事件多 hook 是允许的）。
- `dao-glob-gate.js`（PostToolUse，已有）— **扩展**加前端→design-taste 分支。

**拍板：不建大一统分发器，而是「一个新极简 hook（dao-rhythm）+ 扩展一个已有 hook（glob-gate）」**。这比单分发器更符合为道日损——没有为「统一」而新建一个吞掉 cn-title 的大文件，各 hook 单一职责。（修正第 1 轮「倾向单分发器」的判断：当信号少时，扩展现有 > 新建统一。）

---

## 双栈不对称：Windsurf 无 hook（第 3 轮 · 重要约束）

第 2 轮横向研究证实：**Windsurf（及 Cursor/Copilot/Codex）都没有 hook 生命周期，只有规则系统。** 所以 hook 化的自动行为**天然是 Claude Code 独有，无法镜像到 .devin 侧**。这冲击「双栈同源」原则。

**解法（套用第 1 轮框架）**：触发是宿主特定的，内容是共享的。
- **内容层**（skill 正文：怎么 recall / 怎么 design-taste / 怎么 distill）→ 双栈镜像，照旧同源。
- **触发层**（何时做）→ 宿主各表：Claude Code 用 hook（硬、可靠）；Windsurf 无 hook，只能用 always_on 规则表达同一**意图**（软、AI 判断）。

**记录为设计不变量**：dao 的自动行为层是**「同一意图，双栈异构触发」**——CC 侧 hook 确定性触发，Windsurf 侧软规则倡导。smoke test 不应要求 hook 双栈对等（hook 本就是 CC 独有），只需校验 skill 内容双栈同源。这也修正了「改一条规则两侧都要改」的机械同源观——触发机制本就该随宿主能力而异（道法自然·因宿主之性）。

---

## dao.md 体积预算（第 3 轮 · 采纳收敛方向 3）

实测 `dao.md` = 9.4 KB / 128 行。业界参照：Windsurf global rules 6 KB、workspace 12 KB；Codex 32 KiB。dao.md 介于 Windsurf 两档之间，**偏精简未膨胀**，但无显式上限。

**采纳**：给 always_on 根基文件设软上限 **12 KB**（对齐 Windsurf workspace 档）。超过则触发「为道日损」审查——是否有可降级为 skill（按需加载）的内容。不设硬阻断（dao 不靠禁令），只作为 dao-evolve 健康检查的一条体检项。

---

## 落地骨架草图（第 3 轮起草，待第 4 轮细化）

```
1. dao-rhythm.js（新）· UserPromptSubmit
   - 读 stdin.prompt，strip 噪音（复用 cn-title 的 strip）
   - 回顾词正则命中 → 注入「先搜 memory 索引 + docs/evolution，勿凭记忆答」
   - 强收尾信号正则命中 → 注入「本会话有真洞察→dao-evolution 三层路由；纯执行则跳过」
   - 两者皆无 → exit 0 静默（多数回合应静默——无信号即无动作，避免 context 污染）
   - 任何异常 exit 0 优雅降级（复用 cn-title 范式）
   - ≤1 指针/回合（回顾优先于收尾，避免叠加噪音）

2. dao-glob-gate.js（扩展）· PostToolUse
   - 现有 isCode / isDaoMeta 分支保留
   - 加 isFrontend（.tsx/.jsx/.vue/.svelte/.css/.scss）→ 注入「过 dao-design-taste：照 Open Design 原型 / 字号体系 / a11y」

3. settings.json 注册
   - UserPromptSubmit 数组追加 dao-rhythm.js（cn-title 之后）
   - glob-gate 无需改注册（仅改脚本内容）
   - 防 BOM（claude-settings-self-heal 教训）

4. dao.md
   - 「各复归其根」段：rule 只述原则 + 指向 dao-evolution skill，删除任何「靠记忆触发」的措辞
   - 加一句软规则收编中断感知（T3，AI 判断而非 hook）
   - 体积预算注释（≤12KB）
```

**未决（第 4 轮）**：
- 回顾词 / 强收尾信号的精确正则 + 豁免清单（降噪是成败关键，需像 tool-nudge 那样仔细）。
- 「轻量会话状态」是否需要（判断「刚发生 git push」需读 transcript 尾部）——成本 vs 收益，倾向 MVP 先不读状态，只靠 prompt 文本信号。
- SessionStart(source=compact) 救教训：是否纳入 MVP，还是 v2。倾向 v2（先做高频高值的回顾 + T1）。

---

## 信号正则 + 降噪（第 4 轮 · 核心难点）

降噪是节律 hook 成败关键——误触一次污染一次 context。原则同 dao-tool-nudge：**宁可漏报，不可滥报**（高精度 > 高召回）。

### 回顾信号（RECALL · T2 · 每次命中都触发）

```js
// 回顾词干：需与疑问标记共现才算（避免"放到之前的位置"这类非提问误触）
const RECALL_STEM   = /之前|以前|上次|上回|当时|早先|原来这|历史上/;
// 强回顾：自带疑问语义，单独命中即可
const RECALL_STRONG = /记得吗|还记得|遇到过吗|碰到过吗|有没有遇到|为什么当时|当初为什么/;
// 疑问标记
const Q_MARK        = /吗|呢|？|\?|是不是|有没有|为什么|为何|是否/;
// 英文回顾
const RECALL_EN     = /\b(did|have)\s+we\b|\bremember\b|\blast time\b|\bpreviously\b/i;
// 命中 = RECALL_STRONG || (RECALL_STEM && Q_MARK) || RECALL_EN
```
注入指针：「回顾类提问——先搜 `memory/` 索引 + `docs/evolution/*.csv` 再答，勿凭记忆」。
**降噪要点**：词干必须 AND 疑问标记，滤掉「之前/上次」作定语的陈述句；强回顾词本身含疑问语义故豁免。

### 收尾信号（CLOSING · T2 边界 · 每会话仅一次，状态文件去重）

```js
// 仅最高置信收尾短语；显式不收 好了/完成/行了/OK/可以了（高歧义，可能是开始或中途确认）
const CLOSING = /收工|今天到这|今天先到这|今天就到这|先到这了?|睡了|睡觉|该睡|下班了?|明天继续|明早继续|告一段落|就这样吧|收尾了|大功告成|全部搞定|都搞定了/;
```
注入指针：「本会话若产生过真洞察（踩坑/推翻假设/新模式）→ 走 dao-evolution 三层路由；纯执行无洞察则跳过，勿为沉淀而沉淀」。

### 公共降噪（复用 cn-title 范式）
- prompt 以 `/` 开头且去命令后无实质内容 → exit 0。
- strip 噪音（`[Image #N]` / `<tag>` / 空白）后 < 4 字 → exit 0。
- 任何异常 → exit 0 优雅降级。
- **≤1 指针/回合**：回顾优先于收尾（回顾更即时可执行；收尾会复现）。
- 状态：回顾每次命中即触发（每个回顾问题都值得一次搜索，无需冷却）；收尾用 `os.tmpdir()/dao-rhythm/<sid>.closed` 标记，每会话仅一次。

---

## MVP 边界（第 4 轮 · 为道日损）

抵住「一次上全部信号」的冲动（这正是第 1/2 轮的过度伸张）。分两版：

**v1（先发 · 两处改动，皆低噪音高确定）**：
1. 新 `dao-rhythm.js` **只做 RECALL**——最高值（memory 层闭环出口：存了要被想起才有意义）、dao.md 现无此规则（真空白）、噪音最低。
2. 扩 `dao-glob-gate.js`——前端文件 → dao-design-taste nudge（T1 确定信号）。

**v2（v1 实战验证后再加）**：
3. CLOSING → distill 保守提醒（需真实使用验证误触率）。
4. SessionStart(source=compact) → 教训回点（救长对话压缩丢失）。

理由：v1 两改皆可立即单测、低噪音；把需要「实战调误触」和「有状态」的部分推后，避免一次背太多风险。

---

## 落地 plan（v1 · 第 4 轮 · 可执行）

### 文件 1：新建 `ccswitch/hooks/dao-rhythm.js`
```
读 stdin JSON → prompt / session_id
→ strip 噪音；以 / 开头且无实质 rest → exit 0
→ RECALL 命中 → 输出 additionalContext(回顾指针) → exit 0
→ (v2: CLOSING 命中且未标记 → 输出收尾指针 + 写标记 → exit 0)
→ 皆不中 → exit 0 静默（多数回合应静默）
→ try/catch 全包，任何异常 exit 0
hookSpecificOutput.hookEventName = "UserPromptSubmit"
```

### 文件 2：扩 `ccswitch/hooks/dao-glob-gate.js`
在现有 isCode / isDaoMeta 之外加：
```js
const isFrontend = /\.(tsx|jsx|vue|svelte|css|scss|less)$/i.test(norm);
// isDaoMeta / isCode 判定之后，新增分支（注意优先级：前端文件也是 code，
// 应在 isCode 命中时附加 design-taste 提示，而非互斥）→ 倾向：isFrontend 时
// 在 quality 门基础上追加一句「UI 改动另过 dao-design-taste：照 Open Design 原型/字号体系/a11y」
```

### 文件 3：改 `config-sync/common/settings.json`
- UserPromptSubmit 数组在 dao-cn-title.js 之后追加 dao-rhythm.js。
- **坑**：hooks 配置是 `rows[].value` 里的**转义 JSON 字符串**（DB 快照形态），手改易错 → 倾向改 base.json 源头再 sync，或精确编辑转义串；改后防 BOM（[[claude-settings-self-heal]]）。
- 部署后需 `dao-sync.bat --deploy`（link-claude）+ 重启会话生效。

### 文件 4：改 `ccswitch/dao.md`（剥离触发职责 + 双栈意图对等）
- 「各复归其根」教训三行已正确指向 skill（行为/记忆/档案层），无需动。
- **新增一句软规则**（实现第 3 轮「同一意图·双栈异构触发」不变量——Windsurf 无 hook，靠软规则表达同一意图）：在「续力」或「知识归位」段加「回顾类提问先搜 memory + docs/evolution 再答，勿凭记忆」。CC 侧由 hook 硬触发，Windsurf 侧由这条软规则倡导。
- 体积预算注释（≤12KB）可并入。

### 验证
```
node scripts/dao-smoke.mjs                     # skill 内容双栈同源不受影响，应仍 35/0
echo '{"prompt":"我们之前遇到过这个问题吗","session_id":"t1"}' | node ccswitch/hooks/dao-rhythm.js   # 期望回顾指针
echo '{"prompt":"把按钮放到之前的位置"}' | node ccswitch/hooks/dao-rhythm.js                          # 期望静默(无疑问标记)
echo '{"prompt":"/clear"}' | node ccswitch/hooks/dao-rhythm.js                                        # 期望静默
echo '{"tool_name":"Edit","tool_input":{"file_path":"src/App.tsx"}}' | node ccswitch/hooks/dao-glob-gate.js   # 期望 design-taste 提示
```

---

## 下一轮计划（第 5 轮）

1. 实测正则：构造 10+ 正/负例（回顾真问题 vs 陈述句含"之前"；强收尾 vs "好了"歧义），验证精度。
2. 写 dao-rhythm.js 完整脚本（非伪码），就地单测。
3. 决策 settings.json 改法：base.json 源头 vs 直接编辑转义串——查 config-sync 部署链确认哪个是真相源。
4. 起草 dao.md 软规则的精确措辞 + 落位（续力段 or 知识归位段）。
5. 通盘自检 + 若设计已稳，输出「实施就绪」标记供用户白天一键落地。

---

## 迭代记录

### 第 1 轮（2026-06-17）
- 纠正「hook 只在工具调用触发」的前提：UserPromptSubmit/Stop 覆盖每回合含纯对话。
- 建立 hook 事件权威能力表（7 个关键事件 + 注入/阻断能力 + 血泪约束）。
- 盘点现有 5 hook / 7 skill / 11 command。
- 产出核心框架：**hook 管何时 · skill 管如何 · rule 管何为 · command 管显式**，正交不重叠。
- 提方案 A（统一节律分发 hook），列 5 个开放问题。
- 首过分诊 18 个 skill/command。

### 第 2 轮（2026-06-17）
- **解决 Stop 存废**：官方文档证实 Stop 注入 additionalContext 会 re-invoke Claude（loop 风险），decision:block 则中止回合——两种都不适用节律，**砍 Stop，全部归 UserPromptSubmit**。
- **横向对照四家工具**：四档触发轴 + AGENTS.md 标准 + 体积上限是收敛设计；**最强发现——规则系统全都没有「生命周期时机」触发能力，那是 hook 独有领域，dao 在 Claude Code 上有独占战略空间**。
- **抓到 vaporware**：「中断感知」只被引用未被实现，是节律 hook 的第一收编对象。
- 补全分诊表（5 个工具 command 定位 C）。
- 精炼方案 A：载体收敛到 UserPromptSubmit(新 dao-rhythm.js) + PostToolUse(扩展 glob-gate)，并回答了用户「四处触及 distill 是否重复」= 各归其位非重复。

### 第 3 轮（2026-06-17）
- **反者道之动·批判收敛**：引入「触发可靠性三层」（T1 工具事件 / T2 高置信词 / T3 模糊重活），砍掉前两轮过度自信的 T3 hook 化（收尾词、中断感知关键词都是高噪音 T3）。
- **逐项重判 7 个候选**：hook 层只承接 T1 全部（扩展 glob-gate）+ T2 回顾（新极简 dao-rhythm.js）+ 保守收尾提醒；中断感知退回 AI 判断（不假装关键词能解决 vaporware）。
- **拍板单 vs 多 hook**：信号少→不建大分发器，「新极简 hook + 扩展现有 hook」更省（修正第 1 轮倾向）。
- **解决双栈不对称**：Windsurf 无 hook→自动行为天然 CC 独有；定为不变量「同一意图·双栈异构触发」（内容同源·触发随宿主），并修正机械同源观。
- **采纳体积预算**：dao.md 9.4KB，设软上限 12KB（对齐 Windsurf workspace）作 dao-evolve 体检项。
- 起草落地骨架 + 划定 MVP 边界（回顾 + design-taste 优先，distill 提醒/compact 救教训列 v2）。

### 第 4 轮（2026-06-17）
- **写出精确正则**：回顾信号（词干 AND 疑问标记 + 强回顾豁免 + 英文）、收尾信号（仅最高置信短语，显式排除"好了/完成/OK"歧义词），公共降噪复用 cn-title 范式。原则「宁可漏报不可滥报」。
- **定 MVP 两版边界**：v1 = dao-rhythm.js 只做 RECALL + glob-gate 扩 design-taste（皆低噪音高确定）；v2 = 收尾 distill 提醒 + compact 救教训（需实战调误触/有状态，推后）。
- **落地 plan 可执行化**：4 文件改动精确到伪码 + 验证命令；标注 settings.json 转义 JSON 坑、双栈同步注意。
- **dao.md 修订草案**：剥离触发职责（教训三行已指向 skill），新增「回顾先搜 memory」软规则实现「同一意图·双栈异构触发」不变量。
- 注：本轮在 /branch 出的分支会话执行；原会话第 3 轮已落盘，本轮承接其第 4 轮计划。

---

## v1 实施记录（2026-06-17）

用户「直接执行」→ 落地 v1 MVP（仅回顾触发 + design-taste 扩展；v2 收尾distill/compact救教训按设计纪律推后）。

### 改动清单
1. **新建** `ccswitch/hooks/dao-rhythm.js`（UserPromptSubmit）——只做 RECALL：回顾词正则命中→注入「先搜 memory+evolution 再答」短指针；多数回合静默；异常 exit 0 优雅降级。
2. **扩展** `ccswitch/hooks/dao-glob-gate.js`——加 isFrontend（.tsx/.jsx/.vue/.svelte/.css/.scss/.less），前端文件叠加 dao-design-taste 提示（.tsx 同时得 quality+design-taste，.css 仅 design-taste）。
3. **注册** dao-rhythm.js 到三处一致：live `~/.claude/settings.json` + git 快照 `config-sync/common/settings.json` + cc-switch DB（`restore.mjs --scope=settings`，占位符已还原真实路径，DB 自动备份）。
4. **dao.md** 加「回顾即检索」软规则；`.devin/rules/knowledge-routing.md` 镜像同一意图——实现「同一意图·双栈异构触发」不变量。

### 验证（全过）
- dao-rhythm 正/负例：强回顾/记得吗→命中；陈述句含「之前」无疑问→静默；slash/普通陈述→静默。
- glob-gate：.tsx→quality+design-taste；.css→design-taste；.py→quality；dao元文件→meta；.txt→静默。
- 三处注册一致性：live/快照/DB 均含 dao-rhythm 且 JSON 合法。
- `node scripts/dao-smoke.mjs` → 35/0。
- live settings.json 合法（不会破坏下次启动）。

### 生效说明
- live 已含 → **下个会话（/clear 或新开）即生效**（hook 在会话启动时加载）。
- DB 已同步 → 未来 cc-switch 切 provider 不会覆盖丢失。
- 本次改动**未提交 git**（遵 loop「不提交」约定），由用户验收后提交。

### v2 待办（实战验证 v1 后）
- CLOSING 强收尾信号→distill 保守提醒（需真实使用调误触率）。
- SessionStart(source=compact)→教训回点（救长对话压缩丢失）。
- 既有 drift：`.devin/rules/knowledge-routing.md` 仍引旧 `data/evolution-*.csv` 路径，与 CC 侧三层路由（docs/evolution/）不一致，待统一。

---

## v2 试验版实施记录（2026-06-17）· 自报告闭环

用户授权做 v2 试验版。只上 CLOSING（收尾→distill 保守提醒），并内建**自报告机制**回答"用户怎么知道该验证了"：

- **CLOSING 分支**：强收尾正则命中→注入 distill 保守提醒；每会话一次（os.tmpdir 状态文件去重）；每次触发埋点到 `_tmp/rhythm-closing.log`（时间+session+触发语，供复盘误触率）。
- **READY 自报告**（最高优先·一次性）：埋点攒够 `CLOSING_THRESHOLD=12` 条→hook 自己注入"v2 验证就绪"播报，让仪器举手。**用户无需主动回忆何时验证**（太上不知有之）。一次性 marker `_tmp/.rhythm-v2-announced` 防重复播报。
- **优先级**：READY > RECALL > CLOSING，≤1 指针/回合。
- compact 救教训仍未做（收益低、触发稀少，再缓）。

### 验证生命周期（谁触发·谁动手）
1. 现在起：hook 静默收集，用户无感。
2. 攒够 12 条：hook 自注入就绪播报→当时会话的 AI 看到→主动报告用户（不靠用户记忆；backstop：dao-evolve 健康检查可查 log 行数 / 用户随时可问）。
3. 用户说"验证"：AI 与用户一起复盘 `_tmp/rhythm-closing.log` 误触率→决定 转正/调参/回退。
4. 收尾清理：删埋点 log + marker（中间物用后即清）；按裁决改代码（转正则去日志保留分支；回退则删 CLOSING 分支）。**删除发生在验证那一步、用户在场，非后台静默删。**

### 测试（全过·测后已清数据）
回顾✓ / 歧义"好了开始吧"静默✓ / 收尾埋点✓ / 会话去重✓ / 跨会话埋点✓ / 攒够12条自动播报✓ / 播报一次性✓。
