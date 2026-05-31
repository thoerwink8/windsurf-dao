---
name: dao-project-structure
description: 项目目录结构约定——.pen 设计文件、PRD.md、specs、组件代码各放哪里。创建新文件、新项目初始化、或讨论"这个文件放哪"时加载。
---

# 目录约定 · 放哪里

> 有名，万物之母也。名正则物归其位。

## 根目录文件（一眼可见的产品文档）

| 文件 | 用途 | 何时创建 |
|---|---|---|
| `README.md` | 项目入口、技术栈、快速开始 | 项目初始化 |
| `AGENT_GUIDE.md` | Agent 指南、架构决策、踩坑记录 | 项目初始化 |
| `TODO.md` | 任务进度、里程碑 | 项目初始化 |
| `PRD.md` | 产品需求全景图 | 有产品需求时 |

**铁律**：PRD / README / TODO / AGENT_GUIDE 放根目录，不藏进 docs/。它们是项目的「门面」，一眼找到。

## docs/ 结构

```
docs/
├── design/                      # 设计资产（设计层 source of truth）
│   ├── <project>.pen            # Pencil 设计源文件（唯一主文件）
│   └── *.png                    # pencil 导出截图（git 可视化 diff）
│
├── specs/                       # 技术文档
│   ├── foundation-standard.md   # Token 规范 + 交互定制 + 组件选型
│   ├── YYYY-MM-DD-*-design.md   # 功能 design spec（dao-brainstorm 产出）
│   └── YYYY-MM-DD-*-plan.md     # 实施 plan（dao-plan 产出）
│
└── superpowers/                 # dao-superpowers 产出（可选）
    ├── specs/
    └── plans/
```

> 注:dao 五步工程仪式的 plan 标准位置是 `docs/specs/<topic>-plan.md`。

## 组件代码目录

```
src/components/        或  apps/<app>/src/components/
├── ui/                # shadcn 基础件（npx shadcn add 产出，不手动改结构）
│   ├── button.tsx
│   ├── dialog.tsx
│   └── ...
├── pool-column.tsx    # 业务组件（pencil 设计 → 代码实现）
├── round-section.tsx
└── ...
```

**区分规则**：
- `ui/` = shadcn 管理的基础件（来源是 `npx shadcn add`）
- 直接放 `components/` = 项目特有的业务组件（来源是 pencil 设计）
- 不要把业务组件塞进 `ui/`，不要把 shadcn 件拿出 `ui/`

## pen 文件约定

- **一个项目一个 pen 文件**：`docs/design/<project>.pen`
- pen 文件包含：Design System（token 层）+ 可复用组件 + 所有页面设计稿
- 导出的 PNG 放同目录，文件名用 pencil 节点 ID（pencil 自动命名）
- pen 文件**应 commit 到 git**（如果磁盘有文件的话）

## 不该出现的文件位置

| 错误位置 | 应该在 |
|---|---|
| `PRD.md` 在 `docs/` 下 | 根目录 |
| `.pen` 在根目录 | `docs/design/` |
| `foundation-standard.md` 在根目录 | `docs/specs/` |
| 业务组件在 `ui/` 下 | `components/` 根层 |
| 设计导出 PNG 在 `src/` 下 | `docs/design/` |
