---
name: memory-relink-needs-content-diff
description: 接 memory Junction 前只比文件名不够——同名不同内容的脚本只警告不拦截，方向判反就静默丢记忆
metadata: 
  node_type: memory
  type: feedback
  originSessionId: d702bd60-19b9-4036-9ffc-973a75a4c0c8
  modified: 2026-08-15T18:23:04.958Z
---

2026-08-16 接链实录（NEW-MACHINE §10）。本机 memory 是普通目录、仓内落后 6 条，派工补齐后我做验收，**多跑了一遍逐文件内容比对**，才发现另有 4 个同名文件两边内容不同。

接链脚本对这类只 `Write-Warning` 不拦截，照样用仓内版覆盖本机。四条的方向并不一致：

| 文件 | 谁更新 | 正确处置 |
|---|---|---|
| claude-settings-self-heal / codex-claude-shared-skills / evolution-symlink-silent-break | 仓内（补了「dao.ps1 已退役」失效标注） | 保留仓内版 |
| orca-json-field-paths | **本机**（多一条 `--peek` 不返回 deliveryId 的实咬教训） | 先同步进仓 |

最后一条差一步就随接链永久丢了——而脚本只会打一行警告，不会拦。

**How to apply:** 接链（或任何「一边覆盖另一边」的同步）前，验收必须做两层：①文件名超集 ②**逐文件内容比对**，且对每个分歧独立判方向（看时间戳、看哪边内容更全）。只验第一层就接链，等于把方向判断交给运气。落地顺序也是死的：脚本对「本机有仓内没有」会 throw，所以补齐必须在接链之前。接上后 `dao-check` 第 ⑨ 项转绿，本机旧内容留在 `memory.bak-<时间戳>` 备份目录。相关：[[evolution-symlink-silent-break]]、[[green-tests-vs-goal-met]]（验收只跑表层检查就报完成）。
