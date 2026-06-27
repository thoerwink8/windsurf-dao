---
name: dao-project-scaffold
description: 项目标准结构模板。首次进入项目时对照检查，缺则建议创建。也可手动调用进行结构审计。
disable-model-invocation: true
---

# 器 · 项目脚手架

> 朴散则为器。圣人用之，则为官长。——《道德经》第 28 章

## 触发时机

- 首次进入一个项目，检测到缺少标准文件时
- 用户手动调用 `/dao-project-scaffold` 进行结构审计
- 创建新项目时

## 标准结构

```
根目录/
  README.md              ← 人看的项目介绍
  CLAUDE.md              ← AI 入口（<80 行，精简指向 rules）

  .claude/
    rules/               ← AI 自动加载的领域规范
      *.md               ← 按领域拆分，paths: frontmatter 条件加载

  docs/
    PROJECT.md           ← 项目仪表盘（替代 TODO.md，Loop 状态变更时自动更新）
    prd.md               ← 产品需求文档（如有）
    plans/               ← 实施计划（按日期命名：YYYY-MM-DD-主题.md）
    specs/               ← Loop 工作区（dao-loop 管理）
      _archive/          ← 已完成 Loop 归档 + INDEX.md
      <topic>/           ← 活跃 Loop（spec.md + acceptance.md + plan.md + STATUS.json）
```

## 原则

### 根目录法则

根目录只放**活文档**——每天可能打开的文件：
- `README.md`：给人看的项目介绍
- `CLAUDE.md`：给 AI 看的入口（<80 行）

历史文档、参考资料、产品文档全部进 `docs/`。项目追踪用 `docs/PROJECT.md`（Loop 体系自动更新），不在根目录放 TODO.md。

### 唯一 AI 通道

`CLAUDE.md` + `.claude/rules/` 是唯一的 AI 上下文通道。禁止在根目录堆积 `AGENT.md` / `AGENT_GUIDE.md` / `KNOWLEDGE.md` 等冗余入口——它们的内容应归入 `CLAUDE.md` 或 `.claude/rules/`。

### Rules 文件规范

- 按**关注点**拆分，不按层级：`design-tokens.md`、`testing.md`、`architecture.md`
- 加 `paths:` frontmatter 做条件加载，减少 context 噪音
- 不加 frontmatter 则无条件加载（慎用，只用于全局规范）
- 中等项目 3-5 个文件；不要为拆而碎片化

### Docs 组织

- `docs/PROJECT.md`：项目仪表盘（活跃 Loop + Backlog + 里程碑，dao-loop 自动更新）
- `docs/prd.md`：产品需求
- `docs/plans/`：实施计划，按日期命名 `YYYY-MM-DD-主题.md`
- `docs/specs/`：Loop 工作区（活跃 loop 目录 + `_archive/` 归档），由 dao-loop 管理

## Open Design 项目附加结构（条件触发）

**触发条件**：项目根存在 `design/` 目录（即由 Open Design 产出设计资产的项目）。

此类项目除上述通用结构外，`design/` 内必须遵循设计稿生命周期结构：

```
design/
  {page}.html              ← 正式稿（稳定基准，代码侧唯一参考）
  workspaces/              ← 草稿区（临时，升格后整目录删除）
    README.md              ← 草稿区说明（onboarding）
    {name}/                ← 单个工作区（草稿原型 + WORKSPACE.md）
  archive/                 ← 旧正式稿降格保留（永不删除）
    README.md              ← 归档说明
    {page}-{YYYYMMDD}.html
  handoff/                 ← 交接包（一次升格一个目录）
    {scope}-{YYYYMMDD}/    ← _index / components / types / prompts / acceptance
  CONTEXT.md               ← 会话对齐（新开会话第一眼读）
  CHANGELOG.md             ← 升格日志
```

> **结构与升格流程的单一真相源 = `dao-design`（asset.md）**。本 skill 只在进项目时做存在性检查，不重复定义流程。完整命名约定、升格三步、交接包模板均见 asset.md §B。

**双向闭环**：`design/` 同时支持正向（设计→代码，`dao-design` open.md 消费）与反向（代码→设计，`dao-design` asset.md §A 生成）。两向草稿都汇入 `workspaces/`，共用 asset.md §B 升格——`workspaces/` 是收敛点。

### 代码层映射（设计侧消费，写入 CONTEXT.md 或 CLAUDE.md）

交接包按代码层分文件（components / types / store / prompts / i18n），各层对应的**实际代码目录因技术栈而异**，必须声明一次供 `dao-design` asset.md §B 生成 handoff 时填对路径：

- **设计/代码同仓（monorepo）** → 写项目根 `CLAUDE.md`
- **设计/代码分仓**（design/ 与代码在不同目录，如本类 Open Design 项目）→ 写 `design/CONTEXT.md`（升格在设计侧运行，读 CONTEXT.md）

```markdown
## 设计交接代码层映射
- components → <项目实际组件目录>
- types → <项目实际类型目录>
- prompts → <项目实际 prompt 目录>
```

## 检查清单

首次进入项目时逐项检查：

- [ ] `CLAUDE.md` 存在且 <80 行
- [ ] `.claude/rules/` 存在（可空，但目录要有）
- [ ] 根目录无冗余 AI 入口文件（AGENT.md / AGENT_GUIDE.md 等）
- [ ] `docs/PROJECT.md` 存在（替代旧 TODO.md）
- [ ] `docs/specs/` 存在（Loop 工作区）
- [ ] 根目录无遗留 `TODO.md`（已完成的静态清单应清理）

**若检测到 `design/` 目录，额外检查：**

- [ ] `design/workspaces/` 存在（含 README.md）
- [ ] `design/archive/` 存在（含 README.md）
- [ ] `design/handoff/` 存在
- [ ] `design/CONTEXT.md` 存在（会话对齐入口）
- [ ] `design/CHANGELOG.md` 存在
- [ ] 「设计交接代码层映射」已声明（同仓→CLAUDE.md；分仓→CONTEXT.md）

缺项不自动创建，而是**建议用户创建**并说明理由。dao-loop 预飞检查会自动处理迁移。
