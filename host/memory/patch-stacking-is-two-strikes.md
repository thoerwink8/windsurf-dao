---
name: patch-stacking-is-two-strikes
description: 给同一方案打第二层补丁=「同一种办法连错两次」，必须停手从零重推并把备选摆给用户拍，勿默认替用户取舍
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 8deda73d-55b1-4bdc-bef0-b3826dad855f
  modified: 2026-08-15T07:11:25.154Z
---

2026-08-15 信箱台判例：为治 Orca 横幅注入连打三层补丁（转移身份→run-use 乒乓→自动夺回），每层都在修上一层的副作用，且从未把「删掉整个收信层回归轮询」这个备选摆给用户拍（替用户默认了「秒级值得」）。用户拷问后从零重推，方向经拍板确认，但路径错误成立。

**Why**：补丁在局部看都「小而顺手」，骗过连错计数——违反全局 CLAUDE.md 已有的「同一种办法连错两次就换路」。制度不缺，是识别失守。

**How to apply**：给同一方案打第二层补丁的瞬间视同两连错触发：停手，画出补丁链，从本质需求从零重推，把「删除整层」的备选连同代价表交用户拍板。相关判例见 [[evolution-patch-vs-loop]]。
