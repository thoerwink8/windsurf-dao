---
trigger: model_decision
description: 项目目录结构约定——文件放哪里、根目录放什么、docs/ 怎么组织。创建新文件、新项目初始化、或讨论"这个文件放哪"时读取
---

# 目录约定 · 放哪里

> 有名，万物之母也。名正则物归其位。

## 标准项目结构

根目录放活文档（`README.md` 项目介绍、`AGENT.md` AI 入口 <80 行、`TODO.md` 路线图）。`.devin/rules/*.md` 放 AI 自动加载的领域规范。`docs/` 下放 `prd.md`、`plans/YYYY-MM-DD-主题.md`（统一实施计划）、`design/`（HTML 原型 + 截图）。

## 根目录法则

根目录只放**活文档**——每天可能打开的文件：

| 文件 | 用途 | 何时创建 |
|---|---|---|
| `README.md` | 项目入口、技术栈、快速开始 | 项目初始化 |
| `AGENT.md` | AI 入口（<80 行，精简指向 rules） | 项目初始化 |
| `TODO.md` | 任务进度、里程碑 | 项目初始化 |

**铁律**：历史文档、参考资料、产品文档全部进 `docs/`。`AGENT.md` + `.devin/rules/` 是唯一的 AI 上下文通道——禁止在根目录堆积 `AGENT_GUIDE.md` / `KNOWLEDGE.md` 等冗余入口，它们的内容应归入 `AGENT.md` 或 `.devin/rules/`。

## docs/ 结构

`docs/prd.md`（产品需求）、`docs/plans/`（统一实施计划，不分 specs/superpowers：`YYYY-MM-DD-*-design.md` / `*-plan.md` / `foundation-standard.md`）、`docs/design/`（HTML 原型 + 截图，设计层 source of truth）。

## 组件代码目录

`src/components/ui/` = shadcn 基础件（`npx shadcn add` 产出，不手动改结构）；业务组件直接放 `components/` 根层，不放 `ui/` 子目录。

## 设计资产约定

- 设计产物统一存放在 `design/` 目录（HTML 原型 + 截图）
- HTML 原型是 source of truth，代码实现必须对齐原型
- 通过 `dao-design-open` skill 读取 Open Design 产出并执行三维对齐
- 设计资产**应 commit 到 git**

## design/ 目录条件检查（⚡ 首检软规则）

有 `design/` 目录的项目，检查以下规范文件是否存在于 `.devin/rules/`（或 `.claude/rules/`）：

| 文件 | 用途 | 缺失时 |
|---|---|---|
| `design-tokens.md` | Token 定义与引用规范 | 建议创建（从 CSS 变量或 Tailwind 配置提取） |
| `design-spirit.md` | 四维设计精神（视觉/交互/导航/无障碍） | 建议创建（用 dao-design-standards §4 判据填充） |
| `component-health.md` | 组件包装决策与健康度基线 | 可选（组件体系成熟后再建） |

这是软检查——缺失不阻断工作，但在回答末尾追加一行提醒。

## 不该出现的文件位置

| 错误位置 | 应该在 |
|---|---|
| `AGENT_GUIDE.md` 在根目录 | 内容归入 `AGENT.md` 或 `.devin/rules/` |
| `PRD.md` 在根目录 | `docs/prd.md` |
| 设计 HTML 在根目录 | `design/` |
| 业务组件在 `ui/` 下 | `components/` 根层 |
| 设计截图在 `src/` 下 | `design/` |
| specs/ 和 superpowers/ 分裂 | 统一到 `docs/plans/` |
