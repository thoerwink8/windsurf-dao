---
name: dao-project-scaffold
description: 开工处方统一入口——项目标准结构 + 技术栈门控（前端/桌面调试基建/CI 成本）。首次进入项目时对照检查，缺则建议创建；也可手动调用进行结构审计。
disable-model-invocation: true
---

# 器 · 项目脚手架

> 朴散则为器。圣人用之，则为官长。——《道德经》第 28 章

## 触发时机

- 首次进入一个项目，检测到缺少标准文件时
- 用户手动调用 `/dao-project-scaffold` 进行结构审计
- 创建新项目时

## Supporting Files

本 skill 包含以下 supporting files（按需 Read，不预加载）：

| 文件 | 职责 | 何时读取 |
|---|---|---|
| [design-assets.md](design-assets.md) | Open Design 项目结构（design/ 目录树、代码层映射、PROTOTYPE-SPEC 生成、OD 协议 symlink）+ 检查清单 | 检测到 `design/` 目录时 |
| [desktop-debug-gate.md](desktop-debug-gate.md) | 桌面端（Tauri/Electron）调试基建门控 + migrations 跨层一致性 + 检查清单 | 检测到 `src-tauri/` 或 electron 依赖时 |
| [frontend-gate.md](frontend-gate.md) | 前端技术栈门控（A 样式路线 → frontend-style.md rule 派生；B UI 测试分层 → frontend-ui-testing.md 处方选层）+ 检查清单 | 检测到 react/vue/svelte 依赖或前端目录时 |
| [ci-cost-gate.md](ci-cost-gate.md) | CI 成本门控（PR 多平台矩阵检测）+ 检查清单 | 检测到 `.github/workflows/*.yml` 时 |

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

## 跨层一致性门控索引（技术栈检测）

> 不知常，妄作凶。——跨层注册是"常"，忘注册是"妄"。

某些技术栈天然存在**跨层注册缝隙**——Layer A 的文件存在 ≠ Layer B 知道它存在；某些工程配置天然存在**默认值陷阱**——默认全平台矩阵 ≠ 账单可承受。静态类型检查和编译器都无法捕获这类断路，必须有专用检测。

首次进入项目时，按下表指纹检测，命中则 Read 对应 supporting file 执行详细检查：

| 技术栈指纹 | 缝隙/陷阱 | 详见 |
|-----------|---------|------|
| `design/` 目录存在 | 设计资产结构完整性 | [design-assets.md](design-assets.md) |
| `src-tauri/` 或 electron 依赖 | 调试基建 + `migrations/*.sql` ↔ Rust 注册 | [desktop-debug-gate.md](desktop-debug-gate.md) |
| `react`/`vue`/`svelte` 依赖或前端目录 | 样式技术路线未固化为 rule；UI 测试分层缺失（改动无自动回归面） | [frontend-gate.md](frontend-gate.md) |
| `.github/workflows/*.yml` 存在 | PR 触发多平台矩阵烧穿计费额度 | [ci-cost-gate.md](ci-cost-gate.md) |
| _(未来按需扩展)_ | | |

**扩展模式**：发现新的跨层断路或配置陷阱时，在此表中追加一行 + 对应 supporting file。原则：**能自动检测的不写文档提醒，能测试的不写 check 脚本**。

## 检查清单

首次进入项目时逐项检查：

- [ ] `CLAUDE.md` 存在且 <80 行
- [ ] `.claude/rules/` 存在（可空，但目录要有）
- [ ] 根目录无冗余 AI 入口文件（AGENT.md / AGENT_GUIDE.md 等）
- [ ] **开工包白名单**：根目录存在 `kit.json` manifest → `docs/kit/`（DECISIONS / STACK / INIT / FRONTEND / BACKEND / OPEN-QUESTIONS + acceptance/ + design-prompts/）视为合规结构，不判冗余；kit 文件散落根目录 → 建议按上述映射归位到 `docs/kit/`，不建议删除
- [ ] `docs/PROJECT.md` 存在（替代旧 TODO.md）
- [ ] `docs/specs/` 存在（Loop 工作区）
- [ ] 根目录无遗留 `TODO.md`（已完成的静态清单应清理；**豁免**：项目 CLAUDE.md 将 TODO.md 用作候选池/dogfood 记账制者——此时它是活账本非遗留，不得建议清理。2026-07-22 查冲突 spike 抓获本条与 dao.md 帅节记账制的结构性矛盾，mousse-cli 类项目首当其冲）
- [ ] 上表命中的每个技术栈指纹，其对应 supporting file 的检查清单已过一遍

缺项不自动创建，而是**建议用户创建**并说明理由。dao-loop 预飞检查会自动处理迁移。
