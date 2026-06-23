---
name: dao-brainstorm
description: 模糊需求→设计文档的苏格拉底式精炼。一次一问、必探 2-3 方案、用户审批后才进 plan。
---

# 析 · Brainstorming Lens

> 不知常，妄作凶。——《道德经》第 16 章

## 铁律

```
不挖出真实意图,不进 plan 阶段。
不探索 2-3 个方案,不写 design。
不分块审批 design,不进实施。
```

**HARD-GATE**：design 文档未经用户审批前,不调用任何实施型 skill、不写代码。哪怕用户说"这个很简单,直接做"——简则简,但不可省。

## 9 步检查清单

1. 探索项目上下文（读文件、docs、近期 commits）
2. 评估范围（多子系统 → 先拆）
3. 一次一个澄清问题（多选优先,聚焦 purpose / constraints / 成功标准）
4. 提 2-3 个方案对比（含 trade-off + 推荐 + 理由,含"不做"对照）
5. 分块呈现 design（逐块取得审批,不一次甩全文）
6. 写 design 文档（`docs/specs/YYYY-MM-DD-<topic>-design.md`，commit）
7. spec 自审（占位符 / 内部一致 / 范围 / 歧义,逐项扫）
8. 用户审 spec 文档（等批,有改动重写,不偷跑）
9. 进 dao-plan（唯一下一站）

## 纪律

- 一次一个问题,用对方话术,给选项让用户选
- 2-3 个方案,每个含 trade-off,明确推荐 + 理由,遵循 YAGNI
- design 结构：`理解` → `真正问题` → `备选方案` → `推荐` → `开放问题` → `不在范围`

## delegated-continuous 豁免

autopilot 隔离模式下：AI 自审替代用户审批,只在方向互斥 / 不可逆风险时才问。

## UI 任务

design 审批后、plan 前,若项目有 `design/` 目录则先过 `dao-design-open` 读取设计资产。
