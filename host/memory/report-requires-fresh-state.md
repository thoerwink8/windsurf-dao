---
name: report-requires-fresh-state
description: "向用户汇报工位/PR 状态前必须实刷（worktree ps agents[].state + gh pr），凭印象汇报被用户连抓三次"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 6d32fb06-c548-4268-83cc-fc1c15654662
  modified: 2026-08-14T12:47:51.565Z
---

2026-08-14 新派工流程首跑，用户连续三次先于协调者发现状态变化（工位停摆、审读已交、复核已过），三次都是协调者「凭上一次读取的印象」向用户汇报所致。

**Why:** 多工位并行时状态分钟级在变；协调者的记忆天然滞后，监听器天然有盲区（一次性监听不复挂、评论式审读不进 .reviews[]、基线吞掉存量等待态）。唯一可靠的是官方状态面：`orca worktree ps --json` 的 `agents[].state`（working/done + lastAssistantMessage）和 `gh pr list/view`。

**How to apply:** 任何面向用户的工位状态汇报（包括「在途」「等审」这类一句话定性）之前，先跑一次 ps+PR 实刷；监听器只当唤醒铃，不当真相源。相关档案：windsurf-dao issue #442（看门狗）、#443（顺车清单）。
