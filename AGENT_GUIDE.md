# windsurf-dao · Agent 指南

> 本文件是 windsurf-dao 的活体知识库。演化记录见 `docs/evolution/evolution-entries.csv` + `docs/evolution/evolution-lessons.csv`。
> 项目概览见 `README.md`。

---

## 一、项目概览

**定位**：基于道德经哲学的 AI 配对编程方法论——单栈部署到 Claude Code（Windsurf 侧已于 2026-06-29 退役，`ccswitch/` 为唯一真相源）。

**核心架构**（v2 · 2026-04-26）：心·Rules（元规则）→ 肺·Workflows（编排）→ 肝·Skills（实现）→ 肾·MCP（外部）→ 骨·Stacks（技术栈），虚·Memory 为层间流通之气。

**关键文件**：

| 文件/目录                      | 作用                                                   |
| ------------------------------ | ------------------------------------------------------ |
| `dao.ps1`                      | 工具脚本（status / link-claude / codegraph；Codex skills 归 cc-switch store，dao 只报告不写） |
| `global_rules.md`              | 旧 Windsurf 元规则（已 DEPRECATED，仅历史参考，不再被任何端加载） |
| `ccswitch/commands/dao-*.md` | 9 个命令（dev/commit/distill/doc/evolve/loop/remove/superpowers/gs） |
| `ccswitch/skills/dao-*/`    | 9 个可复用技能（brainstorm/design/evolution/loop/plan/project-scaffold/review/verify/worktree） |
| `docs/classics/道德经.md`         | 一切规则的推导源头，不可修改                           |
| `hooks/dao-*`                  | Git hooks 模板（安装到项目 `.git/hooks/`）             |
| `docs/evolution/evolution-*.csv`         | 演化条目 + 教训库（`dao-evolution` skill 维护）        |
| `ccswitch/agents/dao-*.md`     | subagent profile（指挥官体系 orchestrator-workers，详见 §四）——**两族**：能力型 8 个（strategist/reviewer(-critical)/brainstormer/plan-writer/spec-writer/debugger/worker-batch）+ **官种型 4 个**（implementer/adversary/scout/dogfood，2026-08-07 issue #122 补，见 §4.1 末）。**此处刻意不写总数**：手维护的枚举必过期（本仓已被咬三次），当前有几个 ⇒ `ls ccswitch/agents/`|

**部署原理**：`dao.ps1 link-claude` 把 skills/commands/agents symlink 到 `~/.claude/`，并在 `~/.claude/CLAUDE.md` 经 `@import` 常驻 `ccswitch/dao.md`——每条消息自动注入场域根基，skill 由用户 `/name` 手动触发。（旧 Sidecar workspace / link-global 部署随 Windsurf 退役作废。）

**Rules 架构**：废除早期"道德法术四层"概念。当前规则通过 `ccswitch/dao.md`（全局场域，`@import` 每轮注入）+ 项目 `.claude/rules/`（项目级按需加载）两层投递。

**Orca 共存裁决**（2026-08-10 · issue #299）：本仓是 Orca 托管仓，装进来的 `orchestration` / `orca-cli` 两个 skill 与 dao 在派活/交接/建树等 6 处重叠、2 处硬冲突。用户拍板现场不隔离；**撞上时听谁的裁决**（一句话：dao 为默认，Orca 走显式）见 `docs/ops/orca-dao-conflict-ruling.md`——在本仓派单/交接/建 worktree 前必读那一纸。

---

## 三、变更前自审门

> 修道先于传道。推广给别人的标准，自己先通过。

**每次编辑 dao-* 文件前，必须完成以下自审。**

### 自审清单

**1. 无为审视**（新改动是否引入了“法令滋彰”）

- 有没有新增“禁止 X”显式禁令？→ 改为原则表达
- 有没有新增“路径A/路径B”条件分支？→ 统一为单一流程
- 有没有新增平行追踪文件（plan.md / archive/ 类）？→ 路由到 TODO.md / AGENT_GUIDE.md

**2. 知识归位**（知识已落地）

- `docs/evolution/evolution-entries.csv` / `docs/evolution/evolution-lessons.csv` 已写入本次演化记录？
- TODO.md 已完成项已更新？

**3. 减法确认**（删掉了什么）

- 本次变更删掉了什么冗余？（删掉 = 信息熵减）
- 净增加了多少内容？净增加越少越好

**4. 文档同步**（改动是否影响换机部署）

- 本次改动涉及前置依赖 / 部署命令 / 进 git 的配置类别 / config-sync 导出恢复行为 / 必须手动复制的本机资产？
- 是 → **必须在同一次提交里同步更新 [NEW-MACHINE.md](NEW-MACHINE.md)**（对应映射见该文 §5）。
- 不确定要不要更新 → 默认更新。漏更比多更代价大。

### 约定优先级

自审门是**项目工作约定**，不是全局规则。它只约束在 windsurf-dao 项目中工作的 Agent。其他项目遵循各自的 AGENT_GUIDE.md。

---

## 二、演化索引
> 演化记录已迁移至 `docs/evolution/evolution-entries.csv` + `docs/evolution/evolution-lessons.csv`。
> 使用 `search.py` 搜索教训，使用 `search.py stats` 查看统计。

---

## 四、指挥官体系（Orchestrator-Workers × 小国寡民）

> 小国寡民，使有什佰之器而不用。善用人者，为之下。
> 主会话为帅：谋定、遣将、合成，不亲执批量实现。帅强将轻，官方实证有效。

### 4.0 官方出处（体系依据，非社区推断）

| 官方原则 | 出处 |
|---|---|
| orchestrator-subagent 是覆盖面最广的起点模式 | claude.com/blog/multi-agent-coordination-patterns |
| Opus lead + Sonnet subagents 胜纯 Opus 单兵 90.2% | anthropic.com/engineering/multi-agent-research-system |
| 难题路由强模型，简单任务路由轻模型 | anthropic.com/engineering/building-effective-agents |
| subagent 独立 context，description 决定自动委派 | code.claude.com/docs/en/sub-agents |
| 大规模编排用 workflow 脚本，逐轮决策用 subagent | code.claude.com/docs/en/workflows |
| 反向备选 Advisor：轻模型主驾 + 强模型顾问（性能 +2.7pp / 成本 -11.9%） | claude.com/blog/the-advisor-strategy |

### 4.1 调度图（模型无关：谁坐主会话谁为帅）

| 层级 | model 档 | Agent | 职责 |
|---|---|---|---|
| 帅 | 主会话当前最强（Fable 5 / Opus，随代滚动） | 主会话 | 分解 / 委派 / 合成 / 验证 / 兜底，不亲执批量实现 |
| 将 | fable | strategist | 架构定调、卡死攻坚（决策代价≥100h 才召，2026-07-12 战略报告调档） |
| 校 | opus（Opus 5） | reviewer-critical + 复杂混合实现件 | 核心模块对抗性 review / 扛硬仗 |
| 尉 | **sonnet（Sonnet 5，用户 2026-08-08 拍板）** | brainstormer / plan-writer / spec-writer / reviewer / debugger + 常规实现侦察 | 主力 ~80% 流量；**尉是缺省，偏离才要理由** |
| 兵 | haiku（4.5） | worker-batch | 严格按含完整模板的 spec 执行，零自主判断（无模板则升尉）；**⚠️ 新增门槛「且步数定长 / 循环会分叉则升尉」超出拍板字面，AI 自定待 #70 确认**——未确认前按原判据读，详见 `dao-dispatch.md` §档位分工 |

> 档位数值的**唯一真相源是 `ccswitch/rules/dao-dispatch.md`**（军衔四级制那一行给取值，§档位分工那一节给「哪一档配哪类活」的偏离判据），本表是投影、冲突以那边为准。
> ~~校尉同模型不塌缩档位——协议深度分档，下一代模型分化时两档自然复位。~~ **2026-08-08 复位已发生**：尉落 Sonnet 5 之后校尉不再同模型，协议差与模型差第一次对齐。

档位写死在 `ccswitch/agents/*.md` frontmatter `model:`；帅位不写档——天然继承主会话模型，Fable 换 Opus 或换下一代，体系零改动。用较轻模型坐主会话时即官方 Advisor 变体：帅位遇高难决策临时召 opus strategist 咨询即可。

**官种型 agent（2026-08-07 · issue #122 ②）**：`dao-implementer` / `dao-adversary` / `dao-scout` / `dao-dogfood`。
它们**不是又一批能力档**，是给 `agent_type` 带上官种信息的载体——`dao-subagent-clauses.js` 按
`agent_type` 筛官种条款，而实测 **93.8%（753/803）的派单用 `general-purpose` 底座** ⇒ 筛选恒空转，
官种条款渲染得出来却送不到人手上。修法在派单侧：**派实现/对抗/侦察/dogfood 时选对应的 agent type**，
映射表一个字不动。（复审官那一格已有 `dao-reviewer` 承载，不重复建。）
⚠ **这四个刻意不写 `model:`**：`dao-dispatch.md` §档位实证调整要的是「不传 = 继承主会话最贵档，
默认值站在违例那边」；frontmatter 写死一个档会把兜底方向反过来（帅忘了传 model 时**静默降档**
而不是继承最贵档）。⇒ 与上一段那句「档位写死在 frontmatter」并存但不矛盾：
**能力型写档（它们本就是按档分的），官种型不写档（官种与档位是两个正交维度）。**
⚠ 上表曾写 `尉=sonnet` 与 `dao-dispatch.md` 当时的「尉=Opus 5」对不上——#122 批实现官照直标注未动
（官不自裁「以哪份为准」是对的）；2026-08-07 帅按拍板出处订正：档位真相源是 `dao-dispatch.md`
（用户 2026-07-26 拍板升档改语义），本表为投影，`尉=sonnet` 是 Opus 4.8 时代的滞后值。
**2026-08-08 用户拍板把尉档改回 Sonnet 5，上表已同步。别把这读成「绕了一圈回原点」**：
2026-08-07 订正的是**「以哪份文件为准」**（真相源仍是 `dao-dispatch.md`，那一格没被推翻）；
2026-08-08 改的是**那份真相源里的取值**，出处是用户当日原话「现在我希望直接尉档改 sonnet」。
且两次的 `尉=sonnet` 语义不同——旧值是 Opus 4.8 时代遗留的**未经拍板的滞后值**，
新值是**当日拍板的基线 + 一张写明何时该升档的偏离判据表**（见 `dao-dispatch.md` §档位分工）。

### 4.2 指挥官三职（每次派活的前中后）

1. **谋**（派前）：拆成**相互独立**的子任务——独立性是官方明说的前提；强耦合不拆，主会话直做
2. **遣**（派中）：prompt 给足四要素（目标 / 边界 / 输出格式 / 工具来源）；独立任务一条消息并行同发；告知 worker「最终文本即返回数据」，只回精炼结果不回过程
3. **合**（派后）：验证-去重-排序-综合。帅的 context 是战略资产，不让 worker 的搜索日志与文件原文灌爆它——context 隔离正是官方强调的核心收益

### 4.3 全流程七步（谋·造·成展开）

**谋**：① 析（brainstormer，挖意图出 design）→ ② 设（plan-writer，2-5min 粒度任务清单）
**造**：③ 隔（worker-batch，worktree + 测试基线）→ ④ 编（spec-writer + worker，RED→GREEN→REFACTOR）→ ⑤ 调（主会话，并行派活 + review）
**成**：⑥ 审（reviewer / reviewer-critical，spec compliance + code quality）→ ⑦ 归（主会话，verification → merge/PR/cleanup）
**横切**：dao-debugger（任意阶段遇 bug，3 次失败升 strategist）
**回打**：worker → spec-writer（spec 不清）→ plan-writer（plan 不细）→ brainstormer（需求不明）；reviewer → reviewer-critical（核心模块）→ strategist（架构嫌疑）

### 4.4 三条铁律（嵌入每个 worker profile）

不是建议，是硬约束。worker 违反任一即任务失败：**① 无失败测试不写生产代码 ② 无 fresh 证据不声明完成 ③ 无根因调查不修 bug**

### 4.5 何时**不**走（帅的派前自评）

体系不是免费的（Anthropic 官方实测多 agent ≈ 单 agent 15× token）。**任务价值 < 15× token 成本时不走**：

- ❌ 简单问答 / 闲聊 / 临时澄清 → 主会话直接答
- ❌ 紧耦合架构设计 / 强状态依赖 debug（不可拆）→ 主会话直做
- ❌ 探索性、不确定要做啥 → 先派 brainstormer，别拆 task

**六项自评**（模板化? / 需不同档模型? / 主 context 臃肿? / 子任务真独立? / 值 15× token? / 可真并行?）满足 3+ → 派；否则主会话直做。并发由 harness 自动封顶排队，旧 rate-limit 手控约束（T29，Windsurf 时代）作废。

### 4.6 召唤方式（Claude Code 原生）与 Workflow 编排

- **自动委派**：description 写清「何时用我」，主会话按匹配自动派（官方机制，description 质量 = 委派命中率）
- **显式委派**：Agent 工具指定 subagent_type，独立任务一条消息并行多发；调用时可临场覆盖 model / effort（战略任务给高档，机械任务给 low）
- **升级 Workflow**（重器，须用户明示授权——「用 workflow / ultracode」）：同构子任务 ≥3 可流水线 / 发现类任务需对抗验证（N 怀疑者驳斥投票）/ 编排需可复现可续跑。默认 pipeline 不设 barrier，仅当下一阶段真需全量上游结果（去重 / 汇总 / 早退）才 parallel

### 4.7 部署到其他项目

windsurf-dao 是货架项目。部署方式：`dao.ps1 link-claude` 将 `ccswitch/` 下的 skills、commands、agents 等通过 symlink 部署到 `~/.claude/`，源文件单一存放，编辑即生效。详见 §五 配置同步。

### 4.8 设计要点

金字塔体系的每个环节都从道德经章句推导而来，不是流程指南，是哲学层约束：

| 环节 | dao 实现（现名） | 道德经推导 |
|------|----------|------------|
| 析 | `dao-brainstorm` skill / `dao-brainstormer` agent | 不知常，妄作凶（第16章）|
| 设 | `dao-plan` skill / `dao-plan-writer` agent | 图难于其易，为大于其细（第63章）|
| 隔 | `dao-worktree` skill | 致虚极，守静笃（第16章）|
| 编 | `dao-spec-writer` + `dao-worker-batch` agents | 行不言之教 + 知其雄守其雌（第2、28章）|
| 调 | 主会话并行派活（agents 金字塔） | 江海善下 + 小国寡民（第66、80章）|
| 审 | `dao-review` skill / `dao-reviewer(-critical)` agents | 受国之垢，是谓社稷主（第78章）|
| 归 | 主会话 cleanup（dao-loop closing） | 功遂身退，天之道（第9章）|
| 横切 | `dao-debugger` agent | 反者道之动（第40章）|
| 验 | `dao-verify` skill | 慎终如始，则无败事（第64章）|

> **表里的 `dao-brainstorm` / `dao-plan` / `dao-worktree` / `dao-review` 四个 skill 自 2026-07-27 起是 AI 内部读取件**
> （用户拍板的生态减法）：文件仍在 `ccswitch/skills/` 原地、内容未动、仍按路径 Read，
> 但**不再 symlink 进 `~/.claude/skills/`**，因此不是用户 `/` 命令。判据是使用面——
> 它们在用户键盘全史（`~/.claude/history.jsonl`）里零调用。用户命令表以 `ccswitch/dao.md` 为准。

哲学底色不是装饰——它在推理时提供更深层的约束（见 T28 教训）。

---

## 五、配置同步 · 让新机器也能一键复刻

> 各复归其根。dao 的代码归 git，运行态配置归 cc-switch，cc-switch 的快照归 `config-sync/`。

### 5.1 两层同步

| 层级 | 位置 | 工具 | 同步内容 |
|---|---|---|---|
| **规则/技能/命令** | `ccswitch/` → `~/.claude/` | `dao.ps1 link-claude` | skills、commands、agents、references、styles、hooks、`@import` |
| **运行态配置** | `~/.cc-switch/cc-switch.db` ↔ `config-sync/` | `dao.bat`（四合一）或 `node lib/sync.mjs --<cmd>` | env、hooks、model、statusLine、MCP、providers、prompts |

**关键原则**：`cc-switch` 是运行态真相源；`config-sync` 是它的版本化备份 / 换机恢复工具。日常修改 cc-switch 后，应导出快照到 `config-sync/common/` 并提交；换机时再从快照恢复。

### 5.2 当前机器同步步骤

统一入口：`dao.bat export/restore/doctor/inventory`（或 `node lib/sync.mjs --<cmd>`）。跑完重启 cc-switch 切 provider 下发。

**注意**：`common-secrets.json` 不进 git（含脱敏真实值）。`doctor` 报 `settings.json.env.* 缺失` → 重启 cc-switch 切 provider 即可。

### 5.3 新机器复刻

见 `NEW-MACHINE.md` 完整流程。核心：clone → `dao.ps1 link-claude` → 复制 `common-secrets.json` → `dao.bat restore` → 重启 cc-switch 切 provider → `dao.bat doctor` 确认 0 问题。

### 5.4 同步问题速查

`找不到 sqlite3` → `config-sync/setup-sqlite.ps1`。`secrets 缺真实值` → 补 DB 或删占位符。`env.* 缺失` → 重启 cc-switch 切 provider。`MCP extra=[pencil]` → 客户端本地多注册，非错误。

