# Plan · dao 体系系统升级 v2 (道德经化)

> 万物负阴而抱阳，冲气以为和。  
> 把 11 关键词代谢为道德经原文 8 句根基 + 7 条增补 + 场景树。  
> "选择性使用"工程化为：always_on 心怀根基 + model_decision 场景拉子集。

## 元信息

| 项 | 值 |
|---|---|
| 创建 | 2026-05-10 v2 (代替 v1，v1 因方向调整撤回) |
| 触发 | 用户 11 关键词 → "先研究道德经再给方案" |
| 状态 | **待用户审批 v2** |
| 文件改动 | 5 新建 + 4 修改 = 9 文件（数量同 v1，内容道德经化） |
| 估时 | ~75 分钟（不含审批/讨论；新增 mantra 写作时间） |

## v2 核心变化（vs v1）

| 维度 | v1（撤回） | v2（本版） |
|---|---|---|
| mantra 来源 | 用户 11 关键词 | 道德经 8 句根基 + 7 条增补（共 15 句备选，精筛 8+） |
| mantra 形态 | 表达上偏现代 | 道德经原文为主，现代解释为辅 |
| trigger | always_on 80 行 | always_on **≤30 行**（仅根基）+ 场景表 model_decision 指向 |
| 选择性 | 全量加载 | 心怀根基常驻 + 按场景拉子集 |
| 11 关键词处理 | 显化 | 替换/升级/增补：3 保留 / 5 替换 / 3 升级为 skill / 4 新增 |

## 阶段 0.5 道德经研究关键产物

### 你 11 关键词的代谢路径

```
保留 3：道法自然 (25) / 反者道之动 (40) / 用户无为而你无不为 (37 化用)

替换 5（更道家化）：
  去芜留菁    → 为道日损 (48)
  万法归宗    → 各复归其根 (16)
  唯变所适    → 上善若水 (8)
  推进到底    → 勤而行之 (41) ✚ 慎终如始 (64)
  三思而后行  → 为之于未有 (64) ✚ 致虚守静 (16)

升级 3（道德经更精炼且变成具体 skill）：
  带入用户五感逆向解构...      → 以百姓心为心 (49) → dao-empathy
  发现所有问题解决所有问题      → 病病 (71)         → dao-full-coverage
  完全模拟用户测试所有功能      → 以身观身 (54)     → dao-user-simulation

新增 4（道德经精华增补）：
  + 不言之教 (2)        — 结果说话，不说教
  + 太上不知有之 (17)   — AI 让用户感觉自然
  + 善行无辙迹 (27)     — 不留痕迹
  + 受国之垢 (78)       — 接受批评是 master
```

### dao-mantra.md 内容设计（≤30 行 always_on）

```yaml
---
trigger: always_on
---

# dao 协作 mantra · 心怀八句

> 道法自然。万物负阴而抱阳，冲气以为和。
> 八句根基常驻心间，场景子集按需拉起。

## 八句根基（永驻 · 全场景）

1. **道法自然** (25 章) — 顺应事物本性，不强为
2. **为道日损** (48 章) — 减法优先，新建文件门槛 > 删除门槛
3. **反者道之动** (40 章) — 全盲时反向思考，3 次失败升模型
4. **各复归其根** (16 章) — 万法归一道
5. **道常无为而无不为** (37 章) — 用户无为，AI 无不为
6. **不知常妄作凶** (16 章) — 未读不动笔，未验不声明
7. **慎终如始** (64 章) — 收尾如初，三个关卡必止
8. **太上不知有之** (17 章) — AI 让用户感觉自然，功成而百姓谓我自然

## 场景速查（按需 · model_decision）

| 场景 | 加载路径 | 章句根 |
|---|---|---|
| 接到新任务 | `dao-brainstorm` (已有) | 图难于其易 (63) / 豫兮冬涉川 (15) |
| 理解需求 | `dao-empathy` (新) | 以百姓心为心 (49) |
| 执行编码 | `dao-execute` (已有) | 上善若水 (8) / 勤而行之 (41) |
| 全面体检 | `dao-full-coverage` (新) | 病病 (71) / 方而不割 (58) |
| 用户测试 | `dao-user-simulation` (新) | 以身观身 (54) |
| 收尾交付 | `dao-finish` (已有) | 功遂身退 (9) / 善行无辙迹 (27) |
| 接受批评 | `dao-review` (已有) | 受国之垢 (78) |

## 协同（与现有 rules 边界）

- `global_rules.md` (31 行元规则) — 跨项目根基，本文件深化为 sidecar 项目专用
- `execution.md` (always_on 项目铁律) — 本文件是"心境"，那个是"行为约束"
- `dao-philosophy.md` (manual @调用) — 本文件是日常心怀，那个是深度反思
- `superpowers-gate.md` (always_on 门控) — 本文件是 mantra 心境，那个是触发判定

法不违德，德不违道，道法自然。
```

**精炼度评估**：~30 行（含 frontmatter + 标题 + 引语 + 8 根基 + 场景表 + 协同），符合"≤30 行"严控。

## 三层落地方案（v2 调整）

```
┌─ 层 1 · mantra（1 rule, ≤30 行 always_on） ─┐
│ .devin/rules/dao-mantra.md                │
│ 8 句根基 + 场景表（指向，不展开）              │
└──────────┬───────────────────────────────────┘
           ↓ 场景表指向
┌─ 层 2 · 缺口 skill（3 SKILL.md, model_decision push） ─┐
│ dao-empathy        · 以百姓心为心 (49)                  │
│ dao-full-coverage  · 病病 (71)                          │
│ dao-user-simulation · 以身观身 (54)                     │
└──────────┬─────────────────────────────────────────────┘
           ↓ 编排
┌─ 层 3 · 工程入口（1 workflow） ─────────────────┐
│ /dao-superpowers · 五步工程仪式                  │
│ 与 /dao-dev 差异化（道 vs 术）                   │
└─────────────────────────────────────────────────┘
```

## 文件清单（5 新建 + 4 修改，同 v1 数量）

### 🆕 文件 1：`.devin/rules/dao-mantra.md` (≤30 行，内容见上)

### 🆕 文件 2：`.devin/skills/dao-empathy/SKILL.md`

**Frontmatter**：
```yaml
---
name: dao-empathy
description: 用户视角共情术——以百姓心为心 (49 章)，把 AI 代入用户视角逆向解构需求与现象。任务涉及 UX 决策、需求模糊、用户反馈解读、bug 复现需要换位时自动加载。
---
```

**结构**：
1. 章首引语（49 章「圣人无常心，以百姓心为心」+ 54 章「以身观身」）
2. 与现有"五感"概念边界（dao-cycle 五相是 AI 自身五感；本 skill 是用户视角五感）
3. **以百姓心为心方法**：
   - 视（用户怎么看）：界面观感、信息密度、视觉锚点
   - 听（用户怎么听）：错误提示、成功反馈、loading 状态
   - 触（用户怎么操作）：手感、阻力、反馈延迟
   - 感（用户怎么感受）：情绪锚点、期待落差、信任建立
   - 推（用户怎么推理）：心智模型、操作预期、错误归因
4. **以身观身五步**：
   - 1. 构 Persona（典型用户画像）
   - 2. 走旅程（从入口到目标全流程）
   - 3. 找痛（每步可能的失误/挫败）
   - 4. 听内（用户的内心独白）
   - 5. 反思（这设计真的服务于他吗）
5. 何时激活（清单）
6. 反模式：开发者自我中心 / 想当然式假设 / 不验证就动手
7. 与 dao-brainstorm / dao-frontend-aesthetics / dao-user-simulation 协作

### 🆕 文件 3：`.devin/skills/dao-full-coverage/SKILL.md`

**Frontmatter**：
```yaml
---
name: dao-full-coverage
description: 主动全面体检术——病病 (71 章)，认识到自己看不见的盲点才能不病。业务项目 8 维度扫描，重大变更后/发布前/接手新项目时自动加载。与 dao-evolve（dao 体系自身体检）正交，不冲突。
---
```

**结构**：
1. 章首引语（71 章「夫唯病病，是以不病」）
2. 与 dao-evolve 边界（前者审 dao 体系，后者审业务代码）
3. 与 dao-debug 边界（dao-debug 被动，本 skill 主动）
4. 与 quality.md rule 边界（rule 是编辑触发，本 skill 是定期体检）
5. **8 维度体检清单**：
   - 代码（lint / 死代码 / 复杂度 / 重复）
   - 测试（覆盖率 / 边界 / 假阳性）
   - 文档（README / API doc / 注释陈旧度）
   - 依赖（漏洞 / 过期 / 锁文件健康——参 e163 教训）
   - 配置（env / 默认值 / 敏感信息泄漏）
   - 部署（CI/CD / 环境变量 / 回滚机制）
   - 性能（启动时间 / 内存 / 慢查询）
   - 安全（认证 / 授权 / 输入校验 / 加密）
6. 触发节律（重大变更后 / 发布前 / 接手新项目 / 定期）
7. 报告产出格式（统一表格：维度 + 严重度 + 修复建议）
8. 反模式：「看见就修」（破坏当前任务焦点）vs「记录排队修」原则

### 🆕 文件 4：`.devin/skills/dao-user-simulation/SKILL.md`

**Frontmatter**：
```yaml
---
name: dao-user-simulation
description: 用户视角端到端仿真术——以身观身 (54 章)，用 chrome-devtools/playwright MCP 模拟真实用户走完所有交互路径。功能上线前、UI 重大改动后、用户反馈"卡住了"时自动加载。与 dao-test (TDD 红绿) 互补：那是开发者视角，本 skill 是用户视角。
---
```

**结构**：
1. 章首引语（54 章「以身观身」）
2. 与 dao-test 边界（TDD 单元/集成 vs 用户视角 E2E）
3. 与 dao-empathy 协作（empathy 提供 Persona，simulation 走 Persona）
4. 工具栈（chrome-devtools MCP 主用 / playwright MCP 跨浏览器时用）
5. **仿真五步**：
   - 1. 列路径（穷举所有用户旅程：登录/主流程/边界/异常）
   - 2. 起浏览器（mcp0_navigate_page / browser_preview）
   - 3. 走流程（mcp0_click / fill / take_snapshot 链式）
   - 4. 听回响（list_console_messages / list_network_requests）
   - 5. 记问题（每条问题对应 dao-full-coverage 的某维度）
6. 反模式：只走主流程 / 看截图就行（必须看 console + network） / 用户假设
7. 何时激活（清单）

### 🆕 文件 5：`.devin/workflows/dao-superpowers.md`

**Frontmatter**：
```yaml
---
description: 五步工程仪式——隔离 worktree → 写 plan → 派 implementer → 派 reviewer → 归根 cleanup。代码类核心改动的标准化流程，与 /dao-dev（从需求到交付的全管线）形成"术 vs 道"互补。
---
```

**结构**：
1. 章首引语（合道德经哲学：致虚守静 / 受国之垢）
2. **触发条件**（同 superpowers-gate.md，不重复 - 引用即可）
3. **与 /dao-dev 的差异表**：
   ```
   维度        /dao-dev           /dao-superpowers
   ─────────────────────────────────────────────
   切面        道 (哲学三阶九步)    术 (工程五步)
   适用        需求→交付完整管线    代码类核心改动
   含 UI/文档  是                  否（纯代码）
   产出关卡    🔒×3                worktree+plan+review+finish
   哲学源      道生一二三           致虚守静观复
   ```
4. **五步详细**：
   - 一·隔（dao-worktree）+ turbo 命令模板
   - 二·谋（dao-plan）+ plan 文档位置 + 用户审批
   - 三·造（dao-execute + dao-pyramid 可选）+ task 间 checkpoint
   - 四·审（dao-review）+ 普通/critical 二选一
   - 五·归（dao-finish）+ merge/PR/keep/discard 四选一 + cleanup
5. 反模式（同 superpowers-gate 反模式表，引用）
6. 与 superpowers-gate.md rule 协同：rule = 触发判定 + 反模式约束；workflow = 主动唤起 + 步骤模板

### ✏️ 文件 6：`README.md`（修改 4 处）

- "九个规则文件" → "**十个**规则文件"，表格加 `dao-mantra` 行（trigger: always_on）
- "九个工作流" → "**十个**工作流"，表格加 `/dao-superpowers` 行
- "二十四个技能" → "**二十七个**技能"，分类下加 `dao-empathy` / `dao-full-coverage` / `dao-user-simulation` 行
- 体系架构图无需改

### ✏️ 文件 7：`AGENT_GUIDE.md`（修改）

- §一·关键文件表：rules/skills/workflows 数量更新
- §四·全流程七步：在"析"之前增"共"（dao-empathy 共情阶段）
- 新加一段：mantra 心怀八句的 always_on 加载机制说明

### ✏️ 文件 8：`.devin/rules/README.md`（修改）

- rules 9 → 10，加 dao-mantra 行
- 在 5 层架构归类——属于"协作 mantra"层（新设），位于"元规则" / "项目铁律"之间

### ✏️ 文件 9：`docs/evolution/evolution-entries.csv`（新增 e164）

```
e164,new,2026-05-10,dao-system-v3,🌐,dao 体系道德经化系统升级 — 11 关键词→8 根基+7 增补+3 缺口 skill+1 工程 workflow,
"用户提出 11 关键词期望融入 dao 协作模式。研究道德经全文（81 章王弼本）后，识别用户 11 关键词的代谢路径：3 保留（道法自然 25/反者道之动 40/用户无为 37）、5 替换为道德经原文（去芜留菁→为道日损 48 / 万法归宗→各复归其根 16 / 唯变所适→上善若水 8 / 推进到底→勤而行之 41+慎终如始 64 / 三思而后行→为之于未有 64+致虚守静 16）、3 升级为 skill（带入用户五感→dao-empathy 49 章 / 发现所有问题→dao-full-coverage 71 章 / 模拟用户测试→dao-user-simulation 54 章）、4 新增（不言之教 2 / 太上不知有之 17 / 善行无辙迹 27 / 受国之垢 78）。
设计：dao-mantra.md (always_on ≤30 行) 八句根基常驻 + 场景速查表指向具体 skill；3 个新 skill 通过 description push 按需加载；新 /dao-superpowers workflow 与 /dao-dev (道) 形成 (术) 互补。
关键洞察：
A. 用户 11 关键词中 8 个是道德经原文化用，3 个是真工程缺口。研究道德经原文比保留用户表达更精炼（如"病病"二字胜"发现所有问题解决所有问题" 12 字）。
B. 选择性使用 = always_on 心怀根基（最少负载）+ 场景树指向 skill（按需展开）。不是全量 always_on，不是纯 model_decision。
C. dao 体系自我升级时走 superpowers 五步本身（worktree→plan→execute→review→finish）= 身教重于言教。",
e163,worktree;dao-empathy;dao-full-coverage;dao-user-simulation;dao-superpowers;mantra;道德经;系统升级;sidecar
```

## 风险评估（v2 更新）

| 风险 | 影响 | 缓解 |
|---|---|---|
| mantra rule always_on 增加每条消息上下文 | 低 | 严控 ≤30 行（v1 是 80 行） |
| 道德经原文晦涩，AI 理解不一定到位 | 中 | 每句配 1 行白话解释（"不知常妄作凶 — 未读不动笔，未验不声明"） |
| 8 句根基与 dao-philosophy 八条原则重叠 | 中 | dao-philosophy = 深度反思（manual @调用），dao-mantra = 日常心怀（always_on）。互补不冲突 |
| 3 新 skill 与现有 skill 重叠 | 低 | 已在 description 明写边界差异 |
| dao-superpowers workflow 与 /dao-dev 混淆 | 低 | 头部"差异表"清晰区分 |
| dao-meta 三关某条不过 | 高 | 每个新文件单独审 dao-meta 三关 |
| 净增加 4 文件违反"为道日损" | 中 | 净价值评估：mantra 显化用户散落概念 + 3 真缺口 + 1 工程仪式 = 高价值高熵增；可接受 |

## 验收条件（dao-finish 涅槃门）

- [ ] dao-mantra.md ≤30 行
- [ ] 11 关键词代谢路径在 plan 中清晰呈现，可追溯
- [ ] 8 句根基每句配白话解释
- [ ] 3 新 skill 各有边界差异说明
- [ ] /dao-superpowers 与 /dao-dev 有差异表
- [ ] dao-meta 三关全过
- [ ] README + AGENT_GUIDE + .devin/rules/README 表格同步
- [ ] evolution-entries.csv 加 e164（含道德经研究过程）
- [ ] commit 走 dao-commit 规范，不直推 master
- [ ] 用户最终审批

## 执行顺序（dao-execute 序）

```
阶段 0    探查现有 dao 体系                  ✅ DONE
阶段 0.5  道德经研究 + 主题提炼               ✅ DONE
阶段 0.6  11 关键词代谢路径设计               ✅ DONE
阶段 0.7  选择性触发机制设计                  ✅ DONE
阶段 1    写 plan v2                         ✅ THIS FILE
🔒 用户审批 plan v2
阶段 2    dao-mantra.md (≤30 行 always_on)
阶段 3a   dao-empathy/SKILL.md (49 章)
阶段 3b   dao-full-coverage/SKILL.md (71 章)
阶段 3c   dao-user-simulation/SKILL.md (54 章)
阶段 4    dao-superpowers.md
阶段 5a   README + AGENT_GUIDE + rules/README 同步
阶段 5b   evolution-entries.csv 加 e164
阶段 6    自审 review (dao-meta 三关 + spec compliance)
阶段 7    commit + push + 涅槃归根
```

## 备注

- 本 plan 严格遵循 superpowers-gate 路径要求（`docs/specs/<topic>-plan.md`）
- 本 plan v2 替代撤回的 v1（v1 假设 always_on 80 行+全 11 关键词显化，被用户"选择性使用"反馈否决）
- 本 plan 自身演示 dao 流程：先 brainstorm（你的 11 关键词→挖意图）→ research（道德经全文研究）→ plan（v1→v2 演化）→ 用户审批 → execute → review → finish
- 一切方法回归道德经原文。法不违德，德不违道，道法自然。
