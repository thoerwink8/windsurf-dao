---
name: dao-brainstorm
description: 模糊需求→设计文档的苏格拉底式精炼。一次一问、必探 2-3 方案、用户审批后才进 plan。
disable-model-invocation: true
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

delegated-continuous 模式下：AI 自审替代用户审批,只在方向互斥 / 不可逆风险时才问。

## 开工包豁免（凭 kit manifest 学分认定）

输入若是含 `kit.json` manifest 的开工包（如 TraceyU 导出,文档落位 `docs/kit/`）→ 苏格拉底挖掘**降级为差距扫描**：

- 只对三类发问：kit 未覆盖的新约束 / 内部矛盾项 / OPEN-QUESTIONS 中标 `open` 的条目
- design 文档由 kit 文件引用拼装：`理解`/`真正问题`/`备选方案` 摘自 DECISIONS.md + FRONTEND/BACKEND（引决策 ID,不全文复述）
- 用户审批的是「AI 对 kit 的理解摘要 + 差距清单」；扫描通过 = design 已审批,可进 plan

铁律不破：仍然"不挖出真实意图不进 plan",只是意图的证据来源从对话换成文档（同 refactor 型 loop 以诊断报告为输入的先例）。无 manifest 的散装文档不享豁免。

## UI 任务

design 审批后、plan 前,若项目有 `design/` 目录则先过 `/dao-design`（open.md）读取设计资产。
