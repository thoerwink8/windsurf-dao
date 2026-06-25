---
name: dao-plan
description: 实施 plan 撰写铁律：把已审批的 design 拆成 2-5 分钟粒度的可执行任务清单,每个任务含精确文件路径、完整代码模板、验证命令。"图难于其易,为大于其细"。
---

# 划 · Plan Lens

> 图难于其易，为大于其细。——《道德经》第 63 章

## 铁律

```
不拆到 2-5 分钟粒度,不算 plan。
不给完整代码模板(不留 TODO),不算 plan。
不附验证命令,不算 plan。
plan 必依赖已审批 design,不允许凭空 plan。
```

无 design 就来 plan → 回打 dao-brainstorm。

## plan 文档格式

位置：`docs/specs/<topic>-plan.md`，写完必须用户审批。

```markdown
# Plan: <name>
## 背景（3-5 句）
## 目标（可观测完成判据）
## 任务清单
### Task N: <name> (≈N min)
- 文件: `path` (NEW | MODIFY | DELETE)
- 操作: 一句话
- 完整代码模板: （worker 可直接复制，无 TODO）
- 验证: `可跑命令`
- 依赖: 无 / Task X
## 任务依赖图
## 总验证（全部 task 完成后）
## Out of Scope
```

## 粒度判据

每个 Task 必须满足：时间 ≤5min · 路径精确到文件名 · 代码完整无 TODO · 有可执行验证命令 · 标了依赖。任一不满足 → 拆细。

## 三原则

1. **难拆易**：每个 Task "无脑可做"——拿到 spec 不再需要思考
2. **大拆细**：>5 分钟的工作必拆,每个决策点独立 Task
3. **始足下**：Task 1 必须是可立即开干的具体改动,不是"调研/思考"

## delegated-continuous 豁免

delegated-continuous 模式下：AI 自审替代用户审批,记录"delegated-continuous 下自动通过"。
