# windsurf-dao · Agent 指南

> 本文件是 windsurf-dao 的活体知识库。演化详情见 [docs/evolution.md](docs/evolution.md)。
> 项目概览见 `README.md`。

---

## 一、项目概览

**定位**：Windsurf AI 配对编程方法论——一套基于道德经哲学的 AI 行为规则体系，通过 Sidecar workspace 部署。

**核心架构**：

```
道（不变）→ 德（全局倾向）→ 法（操作流程）→ 术（具体技能）
                    ↕
              虚（层间流通之气）
```

**关键文件**：

| 文件/目录                      | 作用                                                   |
| ------------------------------ | ------------------------------------------------------ |
| `dao.ps1`                      | 工具脚本（status / link-global）                       |
| `global_rules.md`              | 元规则源文件（symlink 到 `~/.codeium/windsurf/memories/`，自动加载到所有项目） |
| `.windsurf/rules/`             | 9 文件 5 层架构（详见 `.windsurf/rules/README.md`）     |
| `.windsurf/workflows/dao-*.md` | 12 个工作流（dev/cycle/autopilot/distill/evolve/...）  |
| `.windsurf/skills/dao-*/`      | 15 个可复用技能（含 cycle 镜头 + 工具 skill）          |
| `references/道德经.md`         | 一切规则的推导源头，不可修改                           |
| `hooks/dao-*`                  | Git hooks 模板（安装到项目 `.git/hooks/`）             |
| `data/evolution-*.csv`         | 演化条目 + 教训库（`dao-evolution` skill 维护）        |
| `.devin/agents/*/AGENT.md`     | 8 个 subagent 金字塔 profile（Superpowers × 模型算力分配，详见 §四）|

**部署原理**：将 windsurf-dao 作为 Sidecar workspace 与目标项目同时打开，rules/skills/workflows 自动跨 workspace 可见。元规则通过 `dao.ps1 link-global` symlink 到 `~/.codeium/windsurf/memories/`，自动加载到所有项目（无需 UI 操作）。

**Rules 架构（v2 · 2026-04-26 重构）**：废除"道德法术四层"概念，对齐 Windsurf 4 种 trigger 机制。详见 `.windsurf/rules/README.md`。

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

- `data/evolution-entries.csv` / `data/evolution-lessons.csv` 已写入本次演化记录？
- TODO.md 已完成项已更新？

**3. 减法确认**（删掉了什么）

- 本次变更删掉了什么冗余？（删掉 = 信息熵减）
- 净增加了多少内容？净增加越少越好

### 约定优先级

自审门是**项目工作约定**，不是全局规则。它只约束在 windsurf-dao 项目中工作的 Agent。其他项目遵循各自的 AGENT_GUIDE.md。

---

## 二、演化索引
> 演化记录已迁移至 `data/evolution-entries.csv` + `data/evolution-lessons.csv`。
> 使用 `search.py` 搜索教训，使用 `search.py stats` 查看统计。

---

## 四、Subagent 金字塔（Superpowers × 模型算力分配）

> 高级模型指挥低级模型干活，自己执行攻坚任务。
> 流程骨架来自 obra/superpowers，模型分配按算力金字塔。

### 4.1 调度图

```
战略层  Opus 4.7 XHigh/Max     ── strategist        架构定调 / 卡死攻坚
                                                   稀少召唤，贵但值
─────────────────────────────────────────────────────────────────
指挥层  Opus 4.7 High          ── reviewer-critical 核心模块对抗性 review
        Sonnet 4.6 Thinking    ── brainstormer      Step 1 苏格拉底问需求
                               ── spec-writer       把 plan 翻成 worker 可执行 spec
                               ── reviewer          two-stage review 主力
                               ── debugger          systematic-debugging 4 phases
        GPT 5.5 Low/High       ── plan-writer       PRD/方案/选型/2-5 分钟任务清单
─────────────────────────────────────────────────────────────────
调度层  Adaptive               ── 主会话默认         调度 + 不确定时兜底
─────────────────────────────────────────────────────────────────
工人层  SWE 1.6 Fast (free)    ── worker-batch      严格按 spec 执行，零自主判断
```

### 4.2 全流程 7 步（Superpowers 骨架）

```
1. brainstorming      → brainstormer    挖真实意图，出 design 文档
2. using-git-worktrees → worker-batch    隔离工作区 + 测试基线
3. writing-plans      → plan-writer     2-5 分钟粒度任务清单
4. subagent-dispatch  → 主会话调度       并行派活 + 两阶段 review
5. test-driven-dev    → spec-writer + worker  RED → GREEN → REFACTOR
6. two-stage review   → reviewer / reviewer-critical  spec compliance + code quality
7. finishing-branch   → 主会话           verification → merge/PR/cleanup

横切：systematic-debugging（任意阶段遇 bug 派 debugger，3 次失败升 strategist）
```

### 4.3 三条铁律（嵌入每个 worker profile）

不是建议，是硬约束。worker 违反任一即任务失败：

```
1. NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
2. NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
3. NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
```

### 4.4 何时**不**走金字塔

金字塔不是免费的（Anthropic 实测多 agent 比单 agent 烧 15× token）。**任务价值 < 15× token 成本时不走**：

- ❌ 简单问答 / 闲聊 / 临时澄清 → 主会话 Adaptive 直接答
- ❌ 紧耦合架构设计（不可拆） → 主会话深度对话
- ❌ 跨多文件 debug 但状态依赖强 → 不要拆 subagent
- ❌ 探索性、不确定要做啥 → 先 brainstormer 别拆 task

适合金字塔的：**批量同质化 + 可拆分 + 价值高** 的任务。

### 4.5 升级路径（失败回打方向）

```
worker 失败              → spec-writer（spec 不清）
spec-writer 失败         → plan-writer（plan 不细）
plan-writer 失败         → brainstormer（需求不明）
普通 reviewer 失败       → reviewer-critical（核心模块）
reviewer-critical 失败   → strategist（架构嫌疑）
debugger 失败 3 次       → strategist（质疑架构本身）
```

### 4.6 召唤方式

- **派 subagent**：让主会话明确说"派 spec-writer subagent 处理 X"，Devin 会按 profile 起后台/前台 subagent
- **手动切模型**：核心模块 review 时手动切到 chip "Claude Opus 4.7 High"，再派 reviewer-critical
- **配 effort 档**：strategist / reviewer-critical 派活前用 Alt+T 切到 XHigh/High

### 4.7 部署到其他项目

windsurf-dao 是货架项目。把这套金字塔带到其他项目两条路：

```powershell
# 路径 A：项目级 Junction（推荐 — 单一源，自动同步）
New-Item -ItemType Junction -Path "D:\target-project\.devin\agents" `
                            -Target "C:\frank\windsurf-dao\.devin\agents"

# 路径 B：全局 Junction（所有 Devin 会话可用）
New-Item -ItemType Junction -Path "$env:APPDATA\devin\agents" `
                            -Target "C:\frank\windsurf-dao\.devin\agents"
```

源文件单一存放，更新 windsurf-dao 后所有项目自动同步。

### 4.8 设计要点与 dao 内生方法论映射

Superpowers 开发范式已**吸收为 dao 内生方法论**，不再作为外部依赖。对应关系：

| 设计要点 | dao 内生实现 | 外部参考(已吸收) |
|---------|-------------|-----------------|
| 7 步工作流 | `dao-dev` 谋造成三段 + 关卡 + 涅槃 | obra/superpowers 7 步 |
| 根因调试 | `dao-debug`(三层螺旋 × 15 武器,**已超越**) | superpowers systematic-debugging 4 phases |
| 红绿循环 TDD | `dao-test`(升级版,知其雄守其雌推导) | superpowers test-driven-development |
| 完成前验证 | `dao-verify`(慎终如始推导) | superpowers verification-before-completion |
| 隔离工作区 | `dao-worktree`(致虚极守静笃) | superpowers using-git-worktrees |
| 金字塔调度 | `dao-pyramid`(小国寡民 + 无为而无不为) | Anthropic 多 agent 论文 + superpowers |
| 两阶段评审 | `dao-review`(知人者智 + 受国之垢) | superpowers requesting-code-review |
| 派活四要素 | `dao-pyramid` 派活四要素段 | Anthropic 多 agent 论文 |
| 2-5 分钟任务粒度 | plan-writer profile + dao-dev §一·谋·设 | superpowers writing-plans |
| Junior engineer 心智模型 | worker-batch profile 强制人格化 | superpowers |
| 模型档位按对抗性挑剔分配 | `dao-pyramid` 金字塔结构 | Sonnet vs Opus 实测分水岭 |
| Adaptive 兜底 + 不确定时降级 | 主会话默认 Adaptive | Windsurf Adaptive 文档 |

**吸收原则**:不照搬,用道德经底色**升级**(见 T28 教训)——哲学层推导让推理深度超越原版。

### 4.9 subagent 调度的判断准则(不强制)

rate limit 实测 ≤ 1 并发(T29 教训)，因此采用"按需判断"而非"每阶段强制派":

```
□ 任务足够模板化?(能写出清晰 spec)
□ 任务需要不同模型档?
□ 主会话 context 已臃肿?
□ rate limit 窗口内还有预算?
□ 任务价值高到值 15× token 成本?
□ 任务可真并行/串行可接受延迟?

同时满足 3+ → 派 subagent
否则 → 主会话直接做(更快,无 rate limit 风险)
```

详见 `.windsurf/workflows/dao-dev.md` Subagent 调度段 和 `.windsurf/skills/dao-pyramid/SKILL.md`。
