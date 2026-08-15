---
name: feedback-star-decisions
description: 拍板类提问必须逐件 STAR 人话讲前因后果，禁止压缩打包问法
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f13f443a-0c91-4452-97de-cb2e7257ebec
  modified: 2026-08-09T06:53:51.262Z
---

用户 2026-08-09 原话：「我希望每一次我拍板，你都要讲前因后果呀，遵从 STAR 法则，不然我看不懂，请说人话。」——当时我把 11 件待拍板压缩成一段选项文字打包问，用户拒答两问。

**Why:** 拍板的前提是看懂。压缩打包省的是 AI 的输出，花的是用户的理解成本——他没参与过程，只看结论列表等于让他盲签。

**How to apply:** 每个待拍板件独立成块，按 STAR 讲：背景（这事怎么冒出来的）/ 要拍什么 / AI 做了什么与建议 / 拍了会怎样。先发完整 STAR 简报正文，AskUserQuestion 只做收口选择、选项里不塞正文。多件可分组问但每件的 STAR 必须在正文出现过。与 [[dao-claude-migration]] 的 #70 拍板中枢配合：#70 的 STAR 表格式就是用户认可的形态，照那个写。
