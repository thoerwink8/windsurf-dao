---
name: gated
metadata:
  node_type: memory
  strikes: 3
  gate: scripts/lib/board-hook.mjs
---

对照样本：基准后 strikes>=2 但已配闸，检查器必须绿。
