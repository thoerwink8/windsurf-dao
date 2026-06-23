---
status: archived
archived_date: 2026-06-23
superseded_by: Open Design 工作流（dao-design-open skill + design/ 目录 HTML 原型）
---

# [已归档] Design: 设计资产工作流 + 项目目录约定

> **归档说明**：本 spec 描述的 Pencil (.pen) 工作流已被 Open Design（HTML 原型 + dao-design-open skill）取代。保留作为历史记录，不再作为实施依据。

> 审批状态：✅ 用户已审批（2026-05-18 00:36 UTC+8）

## 我理解你想做的事

把之前讨论出的「Token 打底 + pencil 设计 + shadcn 按需 + 页面驱动」方案固化为 dao 体系的标准规则，让所有项目都能复用。同时明确 .pen、PRD.md 等文件的存放位置。

## 真正要解决的问题

dao 体系缺少「设计 → 组件 → 页面」这个环节的规范。之前用 dao-ui-mockup 生成 HTML 单文件，但 HTML 是一次性产物，不能作为持续维护的设计源。需要一个持久化的设计工作流。

## 推荐方案（已选定）

### 1. 目录约定

```
<project>/
├── PRD.md                    # 产品需求全景（根目录，与 README 平级）
├── AGENT_GUIDE.md            # Agent 指南（根目录）
├── TODO.md                   # 任务进度（根目录）
├── README.md                 # 项目入口（根目录）
├── docs/
│   ├── design/               # 设计资产
│   │   ├── <project>.pen     # Pencil 设计源文件
│   │   └── *.png             # pencil 导出截图
│   ├── specs/                # 技术 specs + plans
│   │   ├── foundation-standard.md
│   │   ├── YYYY-MM-DD-*-design.md
│   │   └── YYYY-MM-DD-*-plan.md
│   └── superpowers/          # dao-superpowers 产出（可选）
└── apps/ 或 src/
    └── components/
        ├── ui/               # shadcn 基础件
        └── *.tsx             # 业务组件
```

### 2. 设计工作流

```
dao-brainstorm → design spec
    ↓
pencil 设计阶段（新增标准环节）
    ├── Token 层（色板/字体/间距/圆角）
    ├── 业务组件设计（reusable 组件）
    └── 页面设计稿（完整屏幕 × light/dark）
    ↓
dao-plan → 任务清单
    ↓
dao-execute → 代码实现
    ├── shadcn add（按需）
    ├── 业务组件代码
    └── 页面代码
```

### 3. 三层分责

| 层 | 谁管 | 你维护什么 |
|---|---|---|
| shadcn 通用交互 | Radix UI 团队 | 不管 |
| Token + 交互定制 | foundation-standard.md | Token 全表 + 对 shadcn 默认值的覆盖 |
| 业务组件 | pencil + 代码 | 设计 + 实现 + 规范 |

### 4. 组件添加策略

shadcn 组件**按需 add**，不提前装不用的。Token 层保证任何新组件装进来都自动继承设计规范。

## 不在本次范围

- 不替换 dao-ui-mockup skill 本身（它仍可用于快速原型探索，pencil 用于正式设计）
- 不改变 dao-brainstorm / dao-plan / dao-execute 的核心流程
- 不创建新的 dao skill（通过规则约束实现）

## 产出物

| 文件 | 类型 | 说明 |
|---|---|---|
| `.devin/rules/project-structure.md` | 规则 | 项目目录约定 |
| `.devin/rules/design-assets.md` | 规则 | 设计资产管理 + pencil 工作流 |
| 更新 `dao-brainstorm/SKILL.md` | 技能更新 | 加入 pencil 设计环节引导 |
| 更新 `quality.md` | 规则更新 | 前端质量关卡引用 pencil 设计 |
| 更新 `README.md` | 规则索引 | 新增规则导航 |
