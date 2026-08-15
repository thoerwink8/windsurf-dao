---
name: loop-refactor-needs-diagnosis
description: "refactor/audit 型 Loop 谋线必须先诊断扫描再写 spec,否则会从假设而非发现出发导致方向偏差"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 9c374d22-cc08-46f5-b7e1-7d15c7942f3b
---

refactor/audit 型 Loop 谋线必须先做诊断扫描，再让 brainstormer 从发现推导 spec 方向。

**Why:** dao-fusion Loop 跳过诊断直接推导 5 个方向（交接/去重/收敛/闭环/表格恢复），执行完才发现真正的问题是孤岛 skill（playbook 被引用 0 次）和高重叠（autopilot vs dev）。先假设问题再找证据 = 妄作。

**How to apply:** 当 Loop type 是 refactor 或 audit 时，谋线步骤 3 派 fork subagent 扫描目标系统（引用图谱/孤岛/重叠/缺口），诊断报告注入 brainstormer 输入。Feature/fix 型跳过。已写入 dao-loop §4 步骤 3。关联 [[evolution-patch-vs-loop]]。
