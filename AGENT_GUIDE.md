# windsurf-dao · Agent 指南

> 本文件是 windsurf-dao 的活体知识库。演化记录见 `data/evolution-entries.csv` + `data/evolution-lessons.csv`。
> 项目概览见 `README.md`。

---

## 一、项目概览

**定位**：Windsurf AI 配对编程方法论——一套基于道德经哲学的 AI 行为规则体系，通过 Sidecar workspace 部署。

**核心架构**（v2 · 2026-04-26）：

```
心·Rules（元规则）→ 肺·Workflows（编排）→ 肝·Skills（实现）→ 肾·MCP（外部）→ 骨·Stacks（技术栈）
                                    ↕
                              虚·Memory（层间流通之气）
```

**关键文件**：

| 文件/目录                      | 作用                                                   |
| ------------------------------ | ------------------------------------------------------ |
| `dao.ps1`                      | 工具脚本（status / link-global）                       |
| `global_rules.md`              | 元规则源文件（symlink 到 `~/.codeium/windsurf/memories/`，自动加载到所有项目） |
| `.windsurf/rules/`             | 11 文件 5 层架构（详见 `.windsurf/rules/README.md`，含 dao-mantra） |
| `.windsurf/workflows/dao-*.md` | 10 个工作流（dev/cycle/autopilot/commit/distill/doc/evolve/session-sync/thread-tree/superpowers） |
| `.windsurf/skills/dao-*/`      | 27 个可复用技能（元层 4 + 镜头 5 + 方法论 8 + 专项 7 + 道德经化缺口 3） |
| `references/道德经.md`         | 一切规则的推导源头，不可修改                           |
| `hooks/dao-*`                  | Git hooks 模板（安装到项目 `.git/hooks/`）             |
| `data/evolution-*.csv`         | 演化条目 + 教训库（`dao-evolution` skill 维护）        |
| `.devin/agents/*/AGENT.md`     | 8 个 subagent 金字塔 profile（小国寡民 × 算力分配，详见 §四）|

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

**4. 文档同步**（改动是否影响换机部署）

- 本次改动涉及前置依赖 / 部署命令 / 进 git 的配置类别 / config-sync 导出恢复行为 / 必须手动复制的本机资产？
- 是 → **必须在同一次提交里同步更新 [NEW-MACHINE.md](NEW-MACHINE.md)**（对应映射见该文 §5）。
- 不确定要不要更新 → 默认更新。漏更比多更代价大。

### 约定优先级

自审门是**项目工作约定**，不是全局规则。它只约束在 windsurf-dao 项目中工作的 Agent。其他项目遵循各自的 AGENT_GUIDE.md。

---

## 二、演化索引
> 演化记录已迁移至 `data/evolution-entries.csv` + `data/evolution-lessons.csv`。
> 使用 `search.py` 搜索教训，使用 `search.py stats` 查看统计。

---

## 四、Subagent 金字塔（小国寡民 × 算力分配）

> 小国寡民，使有什佰之器而不用。无为而无不为。
> 高级模型出决策，低级模型忠实落地，主会话不亲为而万事成。

### 4.1 调度图

```
战略层  Opus 4.7 XHigh/Max     ── strategist        架构定调 / 卡死攻坚
                                                   稀少召唤，贵但值
─────────────────────────────────────────────────────────────────
指挥层  Opus 4.7 High          ── reviewer-critical 核心模块对抗性 review
        Sonnet 4.6 Thinking    ── brainstormer      Step 1 苏格拉底问需求
                               ── spec-writer       把 plan 翻成 worker 可执行 spec
                               ── reviewer          two-stage review 主力
                               ── debugger          三层螺旋×15武器 深度调试
        GPT 5.5 Low/High       ── plan-writer       PRD/方案/选型/2-5 分钟任务清单
─────────────────────────────────────────────────────────────────
调度层  Adaptive               ── 主会话默认         调度 + 不确定时兜底
─────────────────────────────────────────────────────────────────
工人层  SWE 1.6 Fast (free)    ── worker-batch      严格按 spec 执行，零自主判断
```

### 4.2 全流程七步（谋·造·成展开）

```
谋（析+设）:
  1. 析 · brainstormer    不知常妄作凶——挖真实意图，出 design 文档
  2. 设 · plan-writer     图难于其易——2-5 分钟粒度任务清单

造（编+验）:
  3. 隔 · worker-batch    致虚极守静笃——隔离工作区 + 测试基线
  4. 编 · spec-writer + worker  知其雄守其雌——RED → GREEN → REFACTOR
  5. 调 · 主会话调度       江海善下——并行派活 + 两阶段 review

成（审+归）:
  6. 审 · reviewer / reviewer-critical  受国之垢——spec compliance + code quality
  7. 归 · 主会话           功遂身退——verification → merge/PR/cleanup

横切：dao-debug（任意阶段遇 bug 派 debugger，反者道之动，3 次失败升 strategist）
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

### 4.8 设计要点

金字塔体系的每个环节都从道德经章句推导而来，不是流程指南，是哲学层约束：

| 环节 | dao 实现 | 道德经推导 |
|------|----------|------------|
| 析 | `dao-brainstorm` | 不知常，妄作凶（第16章）|
| 设 | `dao-plan` | 图难于其易，为大于其细（第63章）|
| 隔 | `dao-worktree` | 致虚极，守静笃（第16章）|
| 编 | `dao-execute` + `dao-test` | 行不言之教 + 知其雄守其雌（第2、28章）|
| 调 | `dao-parallel` + `dao-pyramid` | 江海善下 + 小国寡民（第66、80章）|
| 审 | `dao-review` | 受国之垢，是谓社稷主（第78章）|
| 归 | `dao-finish` | 功遂身退，天之道（第9章）|
| 横切 | `dao-debug` | 反者道之动（第40章）|
| 验 | `dao-verify` | 慎终如始，则无败事（第64章）|

哲学底色不是装饰——它在推理时提供更深层的约束（见 T28 教训）。

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
