---
name: dao-review
description: 代码评审铁律：两阶段评审(spec compliance → code quality),失败方向决定回打到哪一层。普通模块用 reviewer,核心模块(支付/认证/安全)派 reviewer-critical。"受国之垢,是谓社稷主"。
---

# 评审 · Review Lens

> 受国之垢，是谓社稷主。——《道德经》第 78 章

## 铁律

```
不对照 spec 不进入质量评审。
不分级(P0/P1/P2/P3) 不算评审。
不指明回打方向 不算 verdict。
受批评者必逐条回应,不擅自驳回。
```

## Two-Stage Review

```
worker 完成 → Stage 1 (spec compliance) → Stage 2 (code quality)
  Stage 1 FAIL → 回打 worker
  Stage 2 FAIL → 回打 worker 或 spec-writer
  核心模块 → Stage 2 升级 reviewer-critical
```

### Stage 1 · spec compliance

只问：做的是不是 spec 要求的事？spec 列的文件都改了？代码模板照搬了？边界没越？验证命令跑了？Stage 1 不过不进 Stage 2。

### Stage 2 · code quality（P0→P3 分级）

| 级别 | 关注点 | 处置 |
|------|--------|------|
| P0 | 明显 bug（空指针/未 await/资源泄漏） | 必须修 |
| P1 | 测试质量（覆盖/行为 vs 实现/水分） | 应该修 |
| P2 | 代码风格（命名/长度/嵌套/一致性） | 建议修 |
| P3 | 架构嗅觉（未来债/不必要复杂度） | 备记 |

### Verdict

`PASS` → finishing · `FAIL - spec 没说清` → 回打 spec-writer · `FAIL - worker 错` → 回打 worker · `ESCALATE` → reviewer-critical 或 strategist

## 升级判据

→ **reviewer-critical**：支付/认证/权限/加密/schema · 跨5+文件强耦合 · P0根因不确定
→ **strategist**：问题在上游 · 架构设计缺陷 · 同模块第3次 P0

## 受国之垢 · 接受批评

接到 review：先全读不抢话 → 逐条分类（同意修 / 同意延后 / 不同意需反证） → P0/P1 默认修不辩论 → 修完必走 dao-verify 贴证据 → 闭环回 reviewer。
