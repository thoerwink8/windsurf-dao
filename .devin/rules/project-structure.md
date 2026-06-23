---
trigger: model_decision
description: 项目目录结构约定——文件放哪里、根目录放什么、docs/ 怎么组织。创建新文件、新项目初始化、或讨论"这个文件放哪"时读取
---

# 目录约定 · 放哪里

> 有名，万物之母也。名正则物归其位。

## 标准项目结构

```
根目录/
  README.md              ← 人看的项目介绍
  AGENT.md               ← AI 入口（<80 行，指向 rules）
  TODO.md                ← 路线图 + 里程碑（活文档）

  .devin/
    rules/               ← AI 自动加载的领域规范（按文件分领域）
      *.md               ← 设计 token / 测试约定 / 架构决策等

  docs/
    prd.md               ← 产品需求文档（如有）
    plans/               ← 所有实施计划（统一目录，按日期命名）
      YYYY-MM-DD-主题.md
    design/              ← 设计资产（HTML 原型 + 截图）
```

## 根目录法则

根目录只放**活文档**——每天可能打开的文件：

| 文件 | 用途 | 何时创建 |
|---|---|---|
| `README.md` | 项目入口、技术栈、快速开始 | 项目初始化 |
| `AGENT.md` | AI 入口（<80 行，精简指向 rules） | 项目初始化 |
| `TODO.md` | 任务进度、里程碑 | 项目初始化 |

**铁律**：历史文档、参考资料、产品文档全部进 `docs/`。`AGENT.md` + `.devin/rules/` 是唯一的 AI 上下文通道——禁止在根目录堆积 `AGENT_GUIDE.md` / `KNOWLEDGE.md` 等冗余入口，它们的内容应归入 `AGENT.md` 或 `.devin/rules/`。

## docs/ 结构

```
docs/
├── prd.md                       # 产品需求（从根目录移入）
├── plans/                       # 所有实施计划（统一，不分 specs/superpowers）
│   ├── YYYY-MM-DD-*-design.md   # 功能 design spec（dao-brainstorm 产出）
│   ├── YYYY-MM-DD-*-plan.md     # 实施 plan（dao-plan 产出）
│   └── foundation-standard.md   # Token 规范等长期参考
└── design/                      # 设计资产（设计层 source of truth）
    ├── *.html                   # Open Design HTML 原型
    └── *.png                    # 截图
```

**不再分 `specs/` 和 `superpowers/` 两套目录**——它们是同一件事的不同阶段，统一放 `plans/`。

## 组件代码目录

```
src/components/        或  apps/<app>/src/components/
├── ui/                # shadcn 基础件（npx shadcn add 产出，不手动改结构）
├── pool-column.tsx    # 业务组件（设计 → 代码实现）
└── ...
```

- `ui/` = shadcn 管理的基础件
- 直接放 `components/` = 项目特有的业务组件
- 不要把业务组件塞进 `ui/`，不要把 shadcn 件拿出 `ui/`

## 设计资产约定

- 设计产物统一存放在 `design/` 目录（HTML 原型 + 截图）
- HTML 原型是 source of truth，代码实现必须对齐原型
- 通过 `dao-design-open` skill 读取 Open Design 产出并执行三维对齐
- 设计资产**应 commit 到 git**

## 不该出现的文件位置

| 错误位置 | 应该在 |
|---|---|
| `AGENT_GUIDE.md` 在根目录 | 内容归入 `AGENT.md` 或 `.devin/rules/` |
| `PRD.md` 在根目录 | `docs/prd.md` |
| 设计 HTML 在根目录 | `design/` |
| 业务组件在 `ui/` 下 | `components/` 根层 |
| 设计截图在 `src/` 下 | `design/` |
| specs/ 和 superpowers/ 分裂 | 统一到 `docs/plans/` |
