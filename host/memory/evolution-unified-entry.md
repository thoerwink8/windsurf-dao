---
name: evolution-unified-entry
description: "用户不该理解工具链拓扑——下游自动调上游,一个入口搞定(太上不知有之)"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 54958f16-8057-4087-9e28-72c3efd87573
---

两个工具要求用户知道先跑哪个、顺序如何，违反"太上不知有之"。解法：下游自动调上游。

**Why:** dao-sync.bat 和 dao.ps1 是两个独立工具，用户需要知道"先跑 sync 恢复 DB，再跑 dao.ps1 部署 skills"。用户原话："用户是不会理解要先跑 dao.ps1 这件事情的"。

**How to apply:** 设计任何多步工具链时，问：用户需要知道几个入口？超过 1 个 → 合并。sync.mjs runDown() 末尾自动调 dao.ps1 link-claude 就是范例。最好的协作让用户感觉不到流程在运转。
