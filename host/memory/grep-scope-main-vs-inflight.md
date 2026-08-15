---
name: grep-scope-main-vs-inflight
description: 问「有没有人做这件事」时 grep 主树会漏——正在做的事当然还没合，答案在在途分支里
metadata: 
  node_type: memory
  type: feedback
  originSessionId: aae45dc7-d4d7-4305-8484-e386328aa79d
  modified: 2026-08-15T16:14:02.065Z
---

2026-08-15 实咬：grep 主树 `scripts/watchdog.mjs` 找 heartbeat 零命中，据此断言「流转器写了心跳但没人消费」，差点让用户拍板把 #471 塞进 #497 重做一遍——而帅·B 的 #505 分支里早就实现了（`watchdog.mjs:35` 第 9 项 flow-stalled 读 `_flow/heartbeat.json`）。

**Why**：主树 = 已合并的世界，在途分支 = 还没进来的世界。**问「有没有人做这件事」时，答案在后者的概率恰恰更高——正在做的事当然还没合。** 这类错比「没查」更危险：它带着「我验证过」的信心。

同日同型第二例：用 `Get-FileHash` 比对 memory 两份副本，报「40 个内容不同」，实际 34 个只是 LF/CRLF 差异，真差异 6 个。**都是真跑了命令、结论仍错——因为查的范围/口径不对。**

**How to apply**：
1. 多分支并行时，grep/find 类查证必须说清查的是哪个树；断言里带上范围（「master 上没有」而不是「没有」）。
2. 问「有没有人在做 X」要同时扫在途分支：`git branch -a` 逐棵树 grep，或 `gh pr list` 看在途单正文/diff。
3. 断言写进任务书前，把「这个测法可能漏什么」也写出来（见 [[dispatch-regex-corpus-and-stall]] 的真语料教训、issue #494 的来源标注提议）。
