---
name: evolution-skill-value-formula
description: "Skill 价值 = 调度频率 × 不可替代性,不被调度的 skill 是纯 context 开销"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 54958f16-8057-4087-9e28-72c3efd87573
---

Skill 的价值 = 被调度的频率 × 解决问题的不可替代性。从未被调度或已被 always_on 场域覆盖的 skill 是纯 description 开销。

**Why:** 38 个 skill 精简到 7 个（2026-06-17），大量 skill 从未在实际会话中被触发，或其内容已被 dao.md always_on 覆盖（如 dao-terminal-resilience 的 shell 规则）。精简后 description 匹配精度显著提升（7 个互不重叠 vs 38 个大量交叉）。

**How to apply:** 新增 skill 前问：(1) 这个知识被调度的频率有多高？(2) 它和现有 always_on/skill 有重叠吗？(3) 不做 skill 放在 dao.md 行不行？低频 + 有重叠 = 不建 skill。与 [[evolution-patch-vs-loop]] 相关。
