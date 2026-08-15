---
name: report-requires-fresh-state
description: "汇报工位/PR 状态、以及拿「某工具坏了」当选型理由之前必须实刷实测，凭印象/凭对话残留被用户连抓四次"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 6d32fb06-c548-4268-83cc-fc1c15654662
  modified: 2026-08-15T12:06:46.818Z
---

2026-08-14 新派工流程首跑，用户连续三次先于协调者发现状态变化（工位停摆、审读已交、复核已过），三次都是协调者「凭上一次读取的印象」向用户汇报所致。

**Why:** 多工位并行时状态分钟级在变；协调者的记忆天然滞后，监听器天然有盲区（一次性监听不复挂、评论式审读不进 .reviews[]、基线吞掉存量等待态）。唯一可靠的是官方状态面：`orca worktree ps --json` 的 `agents[].state`（working/done + lastAssistantMessage）和 `gh pr list/view`。

**How to apply:** 任何面向用户的工位状态汇报（包括「在途」「等审」这类一句话定性）之前，先跑一次 ps+PR 实刷；监听器只当唤醒铃，不当真相源。相关档案：windsurf-dao issue #442（看门狗）、#443（顺车清单）。

**2026-08-15 第四次，换了个面孔：选型环节。** 协调者把用户几小时前那句「先优先解决 gpt 无法 gh 问题」当成当前事实，据此在 AskUserQuestion 里否掉 GPT 审官、并把这个"故障"写进了 issue #491 正文。用户当场纠正「gh 没有坏」，实测四条全过（gh 2.97.0 / 已登录 / issue view / pr list）。**故障陈述会过期，而且过期时没有任何东西报警。** 所以：凡是以「某模型/工具/环境坏了」为由否掉一个方案或选项，出手前必须实测一次，或在选项里明写「未实测」——不许把对话残留当事实摆进选项描述里让用户据此拍板。判例落点 [[decision-applies-to-inflight]] 同源：账本里的旧信息不等于现状。
