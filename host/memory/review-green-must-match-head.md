---
name: review-green-must-match-head
description: 「审官判绿」只对它当时看的那个 commit 有效；合并前必须比对 review.commit_id 与 PR headRefOid
metadata: 
  node_type: memory
  type: feedback
  originSessionId: aae45dc7-d4d7-4305-8484-e386328aa79d
  modified: 2026-08-15T16:40:57.899Z
---

2026-08-15 差点误合 PR #497：审官 15:18 判绿（`review.commit_id = cc53837e`），之后工人又推了两轮（心跳闸返工 + 判据换拓扑事实），HEAD 已到 `c73b0e45`。**判绿之后改的那两轮恰恰是最该审的——它们改的就是合并闸本身。**

是时间戳对不上让我停住的，**没有任何机制拦住我**：`gh pr view` 的 `reviewDecision`/`mergeStateStatus` 都不反映这件事，看到「判绿 + CLEAN」就合是自然反应。

**Why**：审官的绿是对**某一个 commit** 的结论，不是对这个 PR 的永久背书。工人在判绿后继续推是常态（返工、rebase、补测试），而这些改动没有任何人看过。「有审官、有判绿、有 CI 全绿」三件事同时成立，仍然可能合进完全未审的代码——**这正是「看起来一切正常、实际什么都没保证」的典型形态**。

**How to apply**：
1. 人工终审前必查：`gh api repos/{owner}/{repo}/pulls/<N>/reviews --jq '.[-1]|{state,commit_id,submitted_at}'` 与 `gh pr view <N> --json headRefOid` 比对，不等就不合。
2. 取的是**最新那条带判定行的 review** 的 commit_id，不是最新 review（可能有不带判定的普通评论）。
3. 不等时要说清「判绿后又推了 N 个 commit」，光报「不合」对协调者没用。
4. 自动合并的闸（flow.mjs 合并三条件）必须含这一条——2026-08-15 实测它原本没有，已裁定补入（见 issue #480 / PR #497）。

同源：[[report-requires-fresh-state]]（汇报前必实刷）、[[grep-scope-main-vs-inflight]]（查证范围要说清）——都是「结论有有效期/有范围，过期或越界就不成立」。
