---
name: doc-read-on-demand
description: "用户偏好——不要主动通读项目 md 文档,规则类由 harness 每轮注入无需重读,其他文档要改哪个才读哪个"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: d5fa91ee-e119-4aa4-b1b3-0e40288a0ff6
---

用户明确要求：不要每次/主动通读项目里的 md 文档。

区分两类：
- 规则类（`CLAUDE.md` / `dao.md` / `MEMORY.md`）由 Claude Code 每轮**自动注入**（dao.md 走 `@import` 常驻），不是我主动 Read，也无法改成"只注入一次"——这是宿主机制，不必、也不该重复 Read。
- 其他项目文档（`AGENT_GUIDE.md` / `docs/` / spec 等）只在**具体任务需要修改某个文档时**才 Read 那一个,不做开场全量通读。

**Why:** 减少冗余读取与 context 开销,呼应 dao「为道日损」「不知常妄作凶=未读不动笔但也别冗余读」。用户把这当成 memory 的正用——记一次,以后默认遵守,不用再提。

**How to apply:** 任务不需要时不主动扫项目文档；要改哪个读哪个。相关：[[evolution-skill-value-formula]]（不被用的加载即纯开销）。
