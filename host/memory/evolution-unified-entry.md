---
name: evolution-unified-entry
description: "用户不该理解工具链拓扑——下游自动调上游,一个入口搞定(太上不知有之)"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 54958f16-8057-4087-9e28-72c3efd87573
---

两个工具要求用户知道先跑哪个、顺序如何，违反"太上不知有之"。解法：下游自动调上游。

**Why:** 当年 dao-sync.bat 与 dao.ps1 是两个独立工具，用户得知道"先跑 sync 恢复 DB，再跑 dao.ps1 部署 skills"。用户原话："用户是不会理解要先跑 dao.ps1 这件事情的"。（这两个工具已随 #425 退役，此处只作为病灶原型保留。）

**How to apply:** 设计任何多步工具链时，问：用户需要知道几个入口？超过 1 个 → 合并。现行范例：`node scripts/inbox-station.mjs ensure` 一条命令幂等搞定哑终端 + 中继 + coordinator 归属三件事，调用方不需要知道里面有几步、也不需要判断当前处在哪一步。最好的协作让用户感觉不到流程在运转。
